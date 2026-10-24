const router = require('express').Router();
const { body, param } = require('express-validator');
const { tx, query } = require('../db');
const { requireRole } = require('../auth');
const { wrap, validate, HttpError } = require('../http');
const rides = require('../rides');

router.use(requireRole('driver'));

// FR-05: choose the zones served
router.put('/zones', body('zones').isArray(), validate, wrap(async (req, res) => {
  await tx(req.user.id, async (c) => {
    await c.query('DELETE FROM driver_zones WHERE driver_id = $1 AND NOT (zone_id = ANY($2::int[]))', [req.user.id, req.body.zones]);
    await c.query(
      `INSERT INTO driver_zones (driver_id, zone_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`,
      [req.user.id, req.body.zones]);
  });
  res.json({ ok: true });
}));

// FR-05: switch between offline and available
router.post('/status', body('online').isBoolean(), validate, wrap(async (req, res) => {
  const { rows } = await query('SELECT status, location FROM drivers WHERE user_id = $1', [req.user.id]);
  const d = rows[0];
  if (req.body.online) {
    if (!d.location) throw new HttpError(400, 'Set your location on the map first');
    if (d.status === 'offline') await query(`UPDATE drivers SET status = 'available' WHERE user_id = $1`, [req.user.id]);
  } else {
    if (d.status === 'busy') throw new HttpError(409, 'Finish or decline your current ride first');
    await query(`UPDATE drivers SET status = 'offline' WHERE user_id = $1`, [req.user.id]);
  }
  const r = await query('SELECT status FROM drivers WHERE user_id = $1', [req.user.id]);
  res.json(r.rows[0]);
}));

// FR-06: live location
router.post('/location', body('lat').isFloat({ min: -90, max: 90 }), body('lng').isFloat({ min: -180, max: 180 }), validate,
  wrap(async (req, res) => {
    await query(
      `UPDATE drivers SET location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, last_ping_at = now() WHERE user_id = $1`,
      [req.user.id, req.body.lng, req.body.lat]);
    res.json({ ok: true });
  }));

router.get('/offers', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT o.expires_at, rd.* FROM ride_offers o JOIN ride_details rd USING (ride_id)
     WHERE o.driver_id = $1 AND o.status = 'pending' AND o.expires_at > now()`, [req.user.id]);
  res.json(rows.map(({ expires_at, ...ride }) => ({ ride, expires_at, via_regular: ride.booking_type === 'regular' })));
}));

router.post('/offers/:rideId/accept', param('rideId').isUUID(), validate, wrap(async (req, res) => {
  res.json(await rides.acceptOffer(req.user.id, req.params.rideId));
}));

router.post('/offers/:rideId/decline', param('rideId').isUUID(), validate, wrap(async (req, res) => {
  await rides.declineOffer(req.user.id, req.params.rideId);
  res.json({ ok: true });
}));

module.exports = router;
