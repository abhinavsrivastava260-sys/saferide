const router = require('express').Router();
const { body, param } = require('express-validator');
const { tx, query } = require('../db');
const { requireRole } = require('../auth');
const { wrap, validate, HttpError } = require('../http');
const jobs = require('../jobs');

router.use(requireRole('rider'));

// The rider's regular drivers per zone (the ternary PREFERS relationship)
router.get('/regulars', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT rd.driver_id, rd.zone_id, z.name AS zone_name, u.name AS driver_name, d.vehicle_type, d.plate_number,
            d.status, dr.avg_rating, rd.added_at
     FROM regular_drivers rd
     JOIN users u ON u.user_id = rd.driver_id
     JOIN drivers d ON d.user_id = rd.driver_id
     JOIN zones z ON z.zone_id = rd.zone_id
     JOIN driver_ratings dr ON dr.driver_id = rd.driver_id
     WHERE rd.rider_id = $1 ORDER BY rd.added_at`, [req.user.id]);
  res.json(rows);
}));

// FR-11: BR-05 (must have a completed ride with him in that zone) is checked by the regular_eligible trigger.
router.post('/regulars', body('driver_id').isUUID(), body('zone_id').isInt(), validate, wrap(async (req, res) => {
  await query(`INSERT INTO regular_drivers (rider_id, driver_id, zone_id) VALUES ($1,$2,$3)`,
    [req.user.id, req.body.driver_id, req.body.zone_id]);
  res.status(201).json({ ok: true });
}));

router.delete('/regulars/:driverId/:zoneId', param('driverId').isUUID(), param('zoneId').isInt(), validate, wrap(async (req, res) => {
  await query(`DELETE FROM regular_drivers WHERE rider_id = $1 AND driver_id = $2 AND zone_id = $3`,
    [req.user.id, req.params.driverId, req.params.zoneId]);
  res.json({ ok: true });
}));

// FR-14: recurring weekly bookings. BR-06 is the composite foreign key to regular_drivers.
router.get('/recurring', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT b.booking_id, b.driver_id, u.name AS driver_name, b.zone_id, z.name AS zone_name,
            to_char(b.time_of_day, 'HH24:MI') AS time_of_day, b.duration_minutes, b.is_active,
            array_agg(bd.weekday ORDER BY bd.weekday) AS weekdays,
            (SELECT count(*) FROM rides r WHERE r.recurring_booking_id = b.booking_id AND r.slot_start > now()
               AND r.status = 'accepted')::int AS upcoming
     FROM recurring_bookings b
     JOIN recurring_booking_days bd USING (booking_id)
     JOIN users u ON u.user_id = b.driver_id
     JOIN zones z ON z.zone_id = b.zone_id
     WHERE b.rider_id = $1
     GROUP BY b.booking_id, u.name, z.name ORDER BY b.created_at`, [req.user.id]);
  res.json(rows);
}));

router.post('/recurring',
  body('driver_id').isUUID(), body('zone_id').isInt(),
  body('pickup.lat').isFloat(), body('pickup.lng').isFloat(), body('drop.lat').isFloat(), body('drop.lng').isFloat(),
  body('time_of_day').matches(/^\d{2}:\d{2}$/), body('duration_minutes').isInt({ min: 5, max: 240 }),
  body('weekdays').isArray({ min: 1 }), body('weekdays.*').isInt({ min: 1, max: 7 }), validate,
  wrap(async (req, res) => {
    const b = req.body;
    const id = await tx(req.user.id, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO recurring_bookings (rider_id, driver_id, zone_id, pickup_point, drop_point, time_of_day, duration_minutes)
         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, ST_SetSRID(ST_MakePoint($6,$7),4326)::geography, $8, $9)
         RETURNING booking_id`,
        [req.user.id, b.driver_id, b.zone_id, b.pickup.lng, b.pickup.lat, b.drop.lng, b.drop.lat, b.time_of_day, b.duration_minutes]);
      await c.query(`INSERT INTO recurring_booking_days (booking_id, weekday) SELECT DISTINCT $1::uuid, d FROM unnest($2::smallint[]) AS d`,
        [rows[0].booking_id, b.weekdays]);
      return rows[0].booking_id;
    });
    const created = await jobs.generateRecurringRides(id);
    res.status(201).json({ booking_id: id, rides_created: created });
  }));

router.patch('/recurring/:id', param('id').isUUID(), body('is_active').isBoolean(), validate, wrap(async (req, res) => {
  const { rowCount } = await query(`UPDATE recurring_bookings SET is_active = $3 WHERE booking_id = $1 AND rider_id = $2`,
    [req.params.id, req.user.id, req.body.is_active]);
  if (!rowCount) throw new HttpError(404, 'Booking not found');
  if (req.body.is_active) await jobs.generateRecurringRides(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
