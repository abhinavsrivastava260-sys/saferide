const router = require('express').Router();
const { body, param } = require('express-validator');
const config = require('../config');
const { query } = require('../db');
const { requireAdmin } = require('../auth');
const { wrap, validate, HttpError } = require('../http');
const proofs = require('../proofs');

router.use(requireAdmin);

const TABLES = ['users', 'riders', 'drivers', 'zones', 'driver_zones', 'regular_drivers', 'recurring_bookings',
  'recurring_booking_days', 'rides', 'ride_offers', 'ride_events', 'messages', 'ratings'];

router.get('/overview', wrap(async (req, res) => {
  const counts = await query(TABLES.map((t) => `SELECT '${t}' AS name, count(*)::int AS rows FROM ${t}`).join(' UNION ALL '));
  const drivers = await query(`SELECT status, count(*)::int AS n FROM drivers GROUP BY status`);
  const active = await query(
    `SELECT * FROM ride_details WHERE status IN ('requested', 'accepted', 'arrived', 'in_progress')
       AND (booking_type <> 'scheduled' OR slot_start < now() + interval '1 day')
     ORDER BY slot_start LIMIT 50`);
  res.json({ tables: counts.rows, drivers: drivers.rows, active: active.rows });
}));

// FR-04: zones as map polygons
router.post('/zones', body('name').trim().isLength({ min: 2, max: 60 }), body('points').isArray({ min: 3 }), validate,
  wrap(async (req, res) => {
    const pts = req.body.points.map(([lng, lat]) => `${Number(lng)} ${Number(lat)}`);
    pts.push(pts[0]);
    const { rows } = await query(
      `INSERT INTO zones (name, boundary) VALUES ($1, ST_GeogFromText($2)) RETURNING zone_id`,
      [req.body.name, `POLYGON((${pts.join(', ')}))`]);
    res.status(201).json(rows[0]);
  }));

router.delete('/zones/:id', param('id').isInt(), validate, wrap(async (req, res) => {
  try {
    await query('DELETE FROM zones WHERE zone_id = $1', [req.params.id]);
  } catch (err) {
    if (err.code === '23503') throw new HttpError(409, 'This zone has rides on record, so it cannot be deleted (NO ACTION foreign key)');
    throw err;
  }
  res.json({ ok: true });
}));

// FR-19: reports
router.get('/reports', wrap(async (req, res) => {
  const perZoneDay = await query(
    `SELECT z.name AS zone, (r.requested_at AT TIME ZONE $1)::date AS day,
            count(*)::int AS rides,
            count(*) FILTER (WHERE r.status = 'completed')::int AS completed,
            count(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled
     FROM rides r JOIN zones z ON z.zone_id = r.zone_id
     WHERE r.requested_at > now() - interval '14 days' AND z.name NOT LIKE 'proof-%'
     GROUP BY 1, 2 ORDER BY 2 DESC, 1`, [config.tz]);
  const utilisation = await query(
    `SELECT u.name AS driver, d.vehicle_type, d.status,
            count(r.ride_id)::int AS completed_rides,
            round(coalesce(sum(extract(epoch FROM r.ended_at - r.accepted_at)) / 3600, 0)::numeric, 2) AS trip_hours,
            round(coalesce(sum(extract(epoch FROM r.ended_at - r.accepted_at)) / (7 * 24 * 36), 0)::numeric, 2) AS utilisation_pct,
            coalesce(sum(r.fare), 0) AS earnings,
            dr.avg_rating
     FROM drivers d
     JOIN users u ON u.user_id = d.user_id
     JOIN driver_ratings dr ON dr.driver_id = d.user_id
     LEFT JOIN rides r ON r.driver_id = d.user_id AND r.status = 'completed' AND r.ended_at > now() - interval '7 days'
     WHERE u.email NOT LIKE '%@proof.test'
     GROUP BY u.name, d.vehicle_type, d.status, dr.avg_rating
     ORDER BY trip_hours DESC`);
  const cancellation = await query(
    `SELECT coalesce(z.name, 'All zones') AS zone, count(*)::int AS rides,
            count(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
            round(100.0 * count(*) FILTER (WHERE r.status = 'cancelled') / nullif(count(*), 0), 1) AS cancellation_pct
     FROM rides r JOIN zones z ON z.zone_id = r.zone_id
     WHERE z.name NOT LIKE 'proof-%'
     GROUP BY ROLLUP (z.name) ORDER BY z.name NULLS LAST`);
  res.json({ perZoneDay: perZoneDay.rows, utilisation: utilisation.rows, cancellation: cancellation.rows });
}));

// Read-only table browser for the demonstration. Spatial columns are shown as WKT.
router.get('/tables/:name', wrap(async (req, res) => {
  const name = req.params.name;
  if (!TABLES.includes(name)) throw new HttpError(404, 'Unknown table');
  const cols = await query(
    `SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [name]);
  const select = cols.rows.map((c) => (c.udt_name === 'geography'
    ? `left(ST_AsText(${c.column_name}), 80) AS ${c.column_name}` : c.column_name));
  const order = { users: 'created_at DESC', rides: 'requested_at DESC', ride_events: 'event_time DESC',
    messages: 'created_at DESC', ride_offers: 'offered_at DESC', ratings: 'rated_at DESC' }[name] || '1';
  const { rows } = await query(`SELECT ${select.join(', ')} FROM ${name} ORDER BY ${order} LIMIT 200`);
  res.json({ columns: cols.rows.map((c) => c.column_name), rows });
}));

router.get('/rides/:id/events', param('id').isUUID(), validate, wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT e.*, u.name AS actor_name FROM ride_events e LEFT JOIN users u ON u.user_id = e.actor_id
     WHERE e.ride_id = $1 ORDER BY e.event_no`, [req.params.id]);
  res.json(rows);
}));

// Proofs: Section 5.6 tests and Section 6 experiments
const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number(v) || d));
router.post('/proofs/verify', wrap(async (req, res) => res.json(await proofs.runVerification())));
router.post('/proofs/double-booking', wrap(async (req, res) =>
  res.json(await proofs.doubleBooking({ n: clamp(req.body.n, 2, 200, 100) }))));
router.post('/proofs/matching', wrap(async (req, res) =>
  res.json(await proofs.concurrentMatching({ riders: clamp(req.body.riders, 2, 200, 50), drivers: clamp(req.body.drivers, 1, 100, 10) }))));
router.post('/proofs/isolation', wrap(async (req, res) =>
  res.json(await proofs.isolationLevels({ n: clamp(req.body.n, 2, 100, 50) }))));
router.post('/proofs/explain', wrap(async (req, res) =>
  res.json(await proofs.explainMatching({ drivers: clamp(req.body.drivers, 1000, 50000, 20000) }))));

module.exports = router;
