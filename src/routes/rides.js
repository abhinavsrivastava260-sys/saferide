const router = require('express').Router();
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { body, param } = require('express-validator');
const { tx, query } = require('../db');
const { requireRole } = require('../auth');
const { wrap, validate, HttpError } = require('../http');
const { emitTo } = require('../socket');
const rides = require('../rides');

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', '..', 'uploads'),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const coords = (name) => [
  body(`${name}.lat`).isFloat({ min: -90, max: 90 }),
  body(`${name}.lng`).isFloat({ min: -180, max: 180 }),
];

async function loadOwnRide(user, rideId) {
  const ride = await rides.getRide(rideId);
  if (!ride || ![ride.rider_id, ride.driver_id].includes(user.id)) throw new HttpError(404, 'Ride not found');
  return ride;
}

// FR-07/08: instant ride
router.post('/', requireRole('rider'), ...coords('pickup'), ...coords('drop'), validate, wrap(async (req, res) => {
  const active = await query(
    `SELECT 1 FROM rides WHERE rider_id = $1 AND booking_type <> 'scheduled'
       AND status IN ('requested', 'accepted', 'arrived', 'in_progress')`, [req.user.id]);
  if (active.rows[0]) throw new HttpError(409, 'You already have a ride in progress');
  res.status(201).json(await rides.requestInstant(req.user.id, req.body.pickup, req.body.drop));
}));

// FR-13: future slot with a regular driver
router.post('/scheduled', requireRole('rider'), ...coords('pickup'), ...coords('drop'),
  body('driver_id').isUUID(), body('start').isISO8601(), body('minutes').isInt({ min: 5, max: 240 }), validate,
  wrap(async (req, res) => {
    if (new Date(req.body.start) < new Date()) throw new HttpError(400, 'Pick a time in the future');
    res.status(201).json(await rides.bookScheduled(req.user.id, {
      driverId: req.body.driver_id, pickup: req.body.pickup, drop: req.body.drop,
      start: req.body.start, minutes: Number(req.body.minutes),
    }));
  }));

// FR-18: history
router.get('/', wrap(async (req, res) => {
  const col = req.user.role === 'rider' ? 'rider_id' : 'driver_id';
  const { rows } = await query(
    `SELECT * FROM ride_details WHERE ${col} = $1 ORDER BY slot_start DESC LIMIT 100`, [req.user.id]);
  res.json(rows);
}));

router.get('/:id', param('id').isUUID(), validate, wrap(async (req, res) => {
  res.json(await loadOwnRide(req.user, req.params.id));
}));

router.get('/:id/events', param('id').isUUID(), validate, wrap(async (req, res) => {
  await loadOwnRide(req.user, req.params.id);
  const { rows } = await query(
    `SELECT e.event_no, e.from_status, e.to_status, e.event_time, u.name AS actor_name
     FROM ride_events e LEFT JOIN users u ON u.user_id = e.actor_id
     WHERE e.ride_id = $1 ORDER BY e.event_no`, [req.params.id]);
  res.json(rows);
}));

// FR-10
router.patch('/:id/status', param('id').isUUID(),
  body('status').isIn(['arrived', 'in_progress', 'completed', 'cancelled']), validate,
  wrap(async (req, res) => {
    res.json(await rides.changeStatus(req.user, req.params.id, req.body.status));
  }));

// FR-15: ride chat. Who may write is decided by the chat_access trigger (BR-08).
router.get('/:id/messages', param('id').isUUID(), validate, wrap(async (req, res) => {
  await loadOwnRide(req.user, req.params.id);
  await query(`UPDATE messages SET status = 'read' WHERE ride_id = $1 AND sender_id <> $2 AND status <> 'read'`,
    [req.params.id, req.user.id]);
  const { rows } = await query(
    `SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.user_id = m.sender_id
     WHERE m.ride_id = $1 ORDER BY m.created_at`, [req.params.id]);
  res.json(rows);
}));

router.post('/:id/messages', upload.single('media'), param('id').isUUID(), validate, wrap(async (req, res) => {
  const content = (req.body.content || '').trim().slice(0, 2000) || null;
  const mediaUrl = req.file ? `/uploads/${req.file.filename}` : null;
  if (!content && !mediaUrl) throw new HttpError(400, 'Type a message or attach an image');
  const { rows } = await query(
    `INSERT INTO messages (ride_id, sender_id, content, media_url, media_type) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params.id, req.user.id, content, mediaUrl, req.file ? req.file.mimetype : null]);
  const msg = { ...rows[0], sender_name: req.user.name };
  const ride = await rides.getRide(req.params.id);
  emitTo(ride.rider_id, 'chat:message', msg);
  emitTo(ride.driver_id, 'chat:message', msg);
  res.status(201).json(msg);
}));

// FR-17: one rating row per ride; each side fills its own column once.
router.post('/:id/rating', param('id').isUUID(), body('score').isInt({ min: 1, max: 5 }), validate, wrap(async (req, res) => {
  await loadOwnRide(req.user, req.params.id);
  const col = req.user.role === 'rider' ? 'driver_score' : 'rider_score';
  const { rows } = await query(
    `INSERT INTO ratings (ride_id, ${col}) VALUES ($1, $2)
     ON CONFLICT (ride_id) DO UPDATE SET ${col} = EXCLUDED.${col}, rated_at = now()
     WHERE ratings.${col} IS NULL
     RETURNING *`, [req.params.id, req.body.score]);
  if (!rows[0]) throw new HttpError(409, 'You already rated this ride');
  res.json(rows[0]);
}));

module.exports = router;
