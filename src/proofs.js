// Evidence for the guarantees: the verification tests of Section 5.6 and the experiments
// of Section 6. Used by the admin page and by scripts/proofs.js.
const { Pool } = require('pg');
const config = require('./config');
const { pool } = require('./db');
const { MATCH_QUERY } = require('./rides');

const newTag = () => 'proof-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const SLOT = ["'2030-01-07 09:00+05:30'", "'2030-01-07 09:30+05:30'"];

// ---------- Section 5.6: sample data and verification (all rolled back afterwards) ----------
const VERIFY_SETUP = `
INSERT INTO users (user_id, name, email, password_hash, role) VALUES
 ('a0000000-0000-0000-0000-000000000001', 'abc',   'abc@verify.test',   'x', 'rider'),
 ('a0000000-0000-0000-0000-000000000002', 'Sneha',   'sneha@verify.test',   'x', 'rider'),
 ('b0000000-0000-0000-0000-000000000001', 'xyz', 'xyz@verify.test', 'x', 'driver'),
 ('b0000000-0000-0000-0000-000000000002', 'Meena',   'meena@verify.test',   'x', 'driver');
INSERT INTO riders (user_id) VALUES ('a0000000-0000-0000-0000-000000000001'), ('a0000000-0000-0000-0000-000000000002');
INSERT INTO drivers (user_id, license_number, vehicle_type, plate_number, status, location) VALUES
 ('b0000000-0000-0000-0000-000000000001', 'VERIFY000001', 'sedan', 'VF23AB1234', 'available', ST_MakePoint(79.13, 12.97)::geography),
 ('b0000000-0000-0000-0000-000000000002', 'VERIFY000002', 'auto',  'VF23CD5678', 'available', ST_MakePoint(79.14, 12.96)::geography);
INSERT INTO zones (name, boundary) VALUES ('proof-verify', ST_GeogFromText(
 'POLYGON((79.10 12.95, 79.16 12.95, 79.16 13.00, 79.10 13.00, 79.10 12.95))'));
INSERT INTO driver_zones SELECT 'b0000000-0000-0000-0000-000000000001', zone_id FROM zones WHERE name = 'proof-verify';
INSERT INTO zones (name, boundary) VALUES ('proof-verify-2', ST_GeogFromText(
 'POLYGON((79.16 12.95, 79.22 12.95, 79.22 13.00, 79.16 13.00, 79.16 12.95))'));
INSERT INTO rides (ride_id, rider_id, zone_id, pickup_point, drop_point, slot_start, slot_end)
SELECT v.ride_id::uuid, v.rider_id::uuid, z.zone_id, ST_MakePoint(v.px, v.py)::geography,
       ST_MakePoint(79.15, 12.98)::geography, v.s::timestamptz, v.e::timestamptz
FROM zones z, (VALUES
 ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 79.13, 12.97, '2026-10-01 09:00+05:30', '2026-10-01 09:30+05:30'),
 ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 79.12, 12.96, '2026-10-01 09:15+05:30', '2026-10-01 09:45+05:30'),
 ('c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', 79.12, 12.96, '2026-10-01 09:30+05:30', '2026-10-01 10:00+05:30')
) AS v(ride_id, rider_id, px, py, s, e)
WHERE z.name = 'proof-verify';`;

const R1 = "'c0000000-0000-0000-0000-000000000001'";
const R2 = "'c0000000-0000-0000-0000-000000000002'";
const R3 = "'c0000000-0000-0000-0000-000000000003'";
const D1 = "'b0000000-0000-0000-0000-000000000001'";
const D2 = "'b0000000-0000-0000-0000-000000000002'";
const A1 = "'a0000000-0000-0000-0000-000000000001'";
const A2 = "'a0000000-0000-0000-0000-000000000002'";

const VERIFY_STEPS = [
  { id: 'Setup', title: 'Load the sample data (2 riders, 2 drivers, 1 zone, rides c1, c2, c3)', sql: VERIFY_SETUP, expect: 'ok' },
  { id: 'Test 1', rule: 'BR-01, FR-16', title: 'The first ride is accepted by driver 1',
    sql: `UPDATE rides SET driver_id = ${D1}, status = 'accepted', accepted_at = now() WHERE ride_id = ${R1};`,
    check: `SELECT event_no, coalesce(from_status, 'NULL') || ' -> ' || to_status AS change FROM ride_events WHERE ride_id = ${R1} ORDER BY event_no`,
    expect: 'ok', expected: 'UPDATE 1, and two rows in ride_events (NULL -> requested, requested -> accepted)' },
  { id: 'Test 2', rule: 'BR-01', title: 'The same driver tries to accept the overlapping ride (09:15-09:45)',
    sql: `UPDATE rides SET driver_id = ${D1}, status = 'accepted', accepted_at = now() WHERE ride_id = ${R2};`,
    expect: '23P01', expected: 'ERROR: conflicting key value violates exclusion constraint "no_driver_overlap"' },
  { id: 'Test 3', rule: 'BR-02', title: 'An invalid jump in status (requested -> completed)',
    sql: `UPDATE rides SET status = 'completed' WHERE ride_id = ${R2};`,
    expect: 'P0001', expected: 'ERROR: Invalid ride status transition: requested -> completed' },
  { id: 'Test 4', rule: 'BR-05', title: 'Regular driver before any completed ride',
    sql: `INSERT INTO regular_drivers (rider_id, driver_id, zone_id) SELECT ${A1}, ${D1}, zone_id FROM zones WHERE name = 'proof-verify';`,
    expect: 'P0001', expected: 'ERROR: No completed ride with this driver in zone …' },
  { id: 'Complete', rule: 'BR-02, BR-11', title: 'Complete the first ride step by step',
    sql: `UPDATE rides SET status = 'arrived' WHERE ride_id = ${R1};\nUPDATE rides SET status = 'in_progress' WHERE ride_id = ${R1};\nUPDATE rides SET status = 'completed', fare = 148.00, ended_at = now() WHERE ride_id = ${R1};`,
    check: `SELECT event_no, coalesce(from_status, 'NULL') || ' -> ' || to_status AS change FROM ride_events WHERE ride_id = ${R1} ORDER BY event_no`,
    expect: 'ok', expected: 'Five audit rows for c1, ending in_progress -> completed' },
  { id: 'Test 5', rule: 'BR-05', title: 'The same insert as Test 4, repeated',
    sql: `INSERT INTO regular_drivers (rider_id, driver_id, zone_id) SELECT ${A1}, ${D1}, zone_id FROM zones WHERE name = 'proof-verify';`,
    expect: 'ok', expected: 'INSERT 0 1 (the driver is now in the rider\'s regular list)' },
  { id: 'Extra 1', rule: 'BR-01', title: 'Adjacent slot 09:30-10:00 for the same driver (ranges are half-open)',
    sql: `UPDATE rides SET driver_id = ${D1}, status = 'accepted', accepted_at = now() WHERE ride_id = ${R3};`,
    expect: 'ok', expected: 'UPDATE 1: 09:00-09:30 and 09:30-10:00 do not clash' },
  { id: 'Extra 2', rule: 'BR-04', title: 'Driver 2 accepts a ride in a zone he does not serve',
    sql: `UPDATE rides SET driver_id = ${D2}, status = 'accepted', accepted_at = now() WHERE ride_id = ${R2};`,
    expect: 'P0001', expected: 'ERROR: Driver does not serve zone …' },
  { id: 'Extra 3', rule: 'BR-03', title: 'Inserting a ride that is already accepted but has no driver',
    sql: `INSERT INTO rides (rider_id, zone_id, pickup_point, drop_point, status, slot_start, slot_end)
SELECT ${A2}, zone_id, ST_MakePoint(79.13, 12.97)::geography, ST_MakePoint(79.15, 12.98)::geography,
       'accepted', now(), now() + interval '20 minutes' FROM zones WHERE name = 'proof-verify';`,
    expect: '23514', expected: 'ERROR: violates check constraint (driver required once accepted)' },
  { id: 'Extra 4', rule: 'BR-11', title: 'Completing a ride without a fare',
    sql: `UPDATE rides SET status = 'arrived' WHERE ride_id = ${R3};\nUPDATE rides SET status = 'in_progress' WHERE ride_id = ${R3};\nUPDATE rides SET status = 'completed' WHERE ride_id = ${R3};`,
    expect: '23514', expected: 'ERROR: violates check constraint (completed ride needs a fare)' },
  { id: 'Extra 5', rule: 'BR-08', title: 'Sneha, who is not on ride c1, sends a chat message on it',
    sql: `INSERT INTO messages (ride_id, sender_id, content) VALUES (${R1}, ${A2}, 'hello?');`,
    expect: 'P0001', expected: 'ERROR: Sender cannot chat on ride …' },
  { id: 'Extra 6', rule: 'BR-09', title: 'Rating a ride that is not completed',
    sql: `INSERT INTO ratings (ride_id, driver_score) VALUES (${R2}, 5);`,
    expect: 'P0001', expected: 'ERROR: Only completed rides can be rated' },
  { id: 'Extra 7', rule: 'BR-09', title: 'A score outside 1-5 on the completed ride',
    sql: `INSERT INTO ratings (ride_id, driver_score) VALUES (${R1}, 6);`,
    expect: '23514', expected: 'ERROR: violates check constraint on driver_score' },
  { id: 'Extra 8', rule: 'BR-10', title: 'Making rider abc a driver as well',
    sql: `INSERT INTO drivers (user_id, license_number, vehicle_type, plate_number) VALUES (${A1}, 'VERIFYX', 'bike', 'VFX1');`,
    expect: '23503', expected: 'ERROR: violates foreign key (user_id, role) -> users: abc\'s role is rider' },
  { id: 'Extra 9', rule: 'BR-06', title: 'A recurring booking with a driver who is not a regular',
    sql: `INSERT INTO recurring_bookings (rider_id, driver_id, zone_id, pickup_point, drop_point, time_of_day, duration_minutes)
SELECT ${A2}, ${D1}, zone_id, ST_MakePoint(79.13, 12.97)::geography, ST_MakePoint(79.15, 12.98)::geography, '08:30', 30
FROM zones WHERE name = 'proof-verify';`,
    expect: '23503', expected: 'ERROR: violates foreign key to regular_drivers' },
];

async function runVerification() {
  const c = await pool.connect();
  const results = [];
  try {
    await c.query('BEGIN');
    for (const step of VERIFY_STEPS) {
      await c.query('SAVEPOINT step');
      const r = { id: step.id, rule: step.rule, title: step.title, sql: step.sql, expected: step.expected };
      try {
        const out = await c.query(step.sql);
        const last = Array.isArray(out) ? out[out.length - 1] : out;
        r.outcome = `${last.command} ${last.rowCount ?? ''}`.trim();
        r.code = 'ok';
        if (step.check) r.rows = (await c.query(step.check)).rows;
        await c.query('RELEASE SAVEPOINT step');
      } catch (err) {
        r.outcome = `ERROR: ${err.message}`;
        r.code = err.code;
        await c.query('ROLLBACK TO SAVEPOINT step');
      }
      r.pass = r.code === step.expect;
      results.push(r);
    }
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  return results;
}

// ---------- Fixtures for the concurrency experiments (committed, then deleted) ----------
async function createFixture({ drivers = 0, riders = 0, ridesPerRider = 1 }) {
  const tag = newTag();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const z = await c.query(
      `INSERT INTO zones (name, boundary) VALUES ($1, ST_GeogFromText('POLYGON((79.30 12.80, 79.36 12.80, 79.36 12.85, 79.30 12.85, 79.30 12.80))'))
       RETURNING zone_id`, [tag]);
    const zoneId = z.rows[0].zone_id;
    const d = await c.query(
      `WITH u AS (
         INSERT INTO users (name, email, password_hash, role)
         SELECT 'Proof driver ' || g, $1 || '-d' || g || '@proof.test', 'x', 'driver' FROM generate_series(1, $2) g
         RETURNING user_id)
       INSERT INTO drivers (user_id, license_number, vehicle_type, plate_number, status, location)
       SELECT user_id, 'P' || substr(md5(user_id::text), 1, 15), 'sedan', 'P' || substr(md5(user_id::text), 16, 10),
              'available', ST_SetSRID(ST_MakePoint(79.30 + random() * 0.06, 12.80 + random() * 0.05), 4326)::geography
       FROM u RETURNING user_id`, [tag, drivers]);
    await c.query('INSERT INTO driver_zones SELECT unnest($1::uuid[]), $2', [d.rows.map((r) => r.user_id), zoneId]);
    const r = await c.query(
      `WITH u AS (
         INSERT INTO users (name, email, password_hash, role)
         SELECT 'Proof rider ' || g, $1 || '-r' || g || '@proof.test', 'x', 'rider' FROM generate_series(1, $2) g
         RETURNING user_id)
       INSERT INTO riders (user_id) SELECT user_id FROM u RETURNING user_id`, [tag, riders]);
    const rides = await c.query(
      `INSERT INTO rides (rider_id, zone_id, pickup_point, drop_point, slot_start, slot_end)
       SELECT rid, $2, ST_SetSRID(ST_MakePoint(79.30 + random() * 0.06, 12.80 + random() * 0.05), 4326)::geography,
              ST_SetSRID(ST_MakePoint(79.33, 12.82), 4326)::geography, ${SLOT[0]}, ${SLOT[1]}
       FROM unnest($1::uuid[]) AS rid, generate_series(1, $3)
       RETURNING ride_id, rider_id`, [r.rows.map((x) => x.user_id), zoneId, ridesPerRider]);
    await c.query('COMMIT');
    return { tag, zoneId, drivers: d.rows.map((x) => x.user_id), riders: r.rows.map((x) => x.user_id), rides: rides.rows };
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function dropFixture(f) {
  await pool.query('DELETE FROM rides WHERE zone_id = $1', [f.zoneId]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [f.tag + '-%@proof.test']);
  await pool.query('DELETE FROM zones WHERE zone_id = $1', [f.zoneId]);
}

// Many parallel connections, each running fn(client) in its own transaction.
async function parallel(n, isolation, fn) {
  const p = new Pool({ connectionString: config.databaseUrl, max: Math.min(n, 60) });
  // Open the connections first so they all start at nearly the same instant.
  const clients = await Promise.all(Array.from({ length: Math.min(n, 60) }, () => p.connect()));
  clients.forEach((c) => c.release());
  const t0 = Date.now();
  const outcomes = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const c = await p.connect();
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const value = await fn(c, i);
      await c.query('COMMIT');
      return { ok: true, value };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      return { ok: false, code: err.code, message: err.message };
    } finally {
      c.release();
    }
  }));
  const ms = Date.now() - t0;
  await p.end();
  return { outcomes, ms };
}

const tally = (outcomes) => outcomes.reduce((acc, o) => {
  const key = o.ok ? 'succeeded' : o.code === '23P01' ? 'exclusion_violation' : o.code === '40001' ? 'serialization_failure' : `error_${o.code}`;
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

// Experiment 1: n riders' rides for the same slot, n simultaneous accepts by one driver.
async function doubleBooking({ n = 100, isolation = 'READ COMMITTED' } = {}) {
  const f = await createFixture({ drivers: 1, riders: n });
  try {
    const driver = f.drivers[0];
    const { outcomes, ms } = await parallel(n, isolation, (c, i) => c.query(
      `UPDATE rides SET driver_id = $2, status = 'accepted', accepted_at = now() WHERE ride_id = $1`,
      [f.rides[i].ride_id, driver]));
    const held = await pool.query(
      `SELECT count(*)::int AS n FROM rides WHERE driver_id = $1 AND status = 'accepted'`, [driver]);
    const counts = tally(outcomes);
    return {
      experiment: 'Double booking', isolation, attempts: n, ms, counts,
      accepted_rides_for_driver: held.rows[0].n,
      pass: held.rows[0].n === 1 && counts.succeeded === 1,
      sample_error: outcomes.find((o) => !o.ok)?.message,
    };
  } finally {
    await dropFixture(f);
  }
}

// Experiment 3: R riders and D drivers request at once; the matching query must never hand out a driver twice.
async function concurrentMatching({ riders = 50, drivers = 10 } = {}) {
  const f = await createFixture({ drivers, riders });
  try {
    const { outcomes, ms } = await parallel(riders, 'READ COMMITTED', async (c, i) => {
      const ride = f.rides[i];
      const m = await c.query(MATCH_QUERY, [f.zoneId, SLOT[0].slice(1, -1), SLOT[1].slice(1, -1), ride.ride_id]);
      const driverId = m.rows[0]?.user_id;
      if (!driverId) return null;
      await c.query(`INSERT INTO ride_offers (ride_id, driver_id, expires_at) VALUES ($1, $2, now() + interval '30 seconds')`,
        [ride.ride_id, driverId]);
      await c.query(`UPDATE drivers SET status = 'busy' WHERE user_id = $1`, [driverId]);
      await c.query(`UPDATE ride_offers SET status = 'accepted' WHERE ride_id = $1 AND driver_id = $2`, [ride.ride_id, driverId]);
      await c.query(`UPDATE rides SET driver_id = $2, status = 'accepted', accepted_at = now() WHERE ride_id = $1`, [ride.ride_id, driverId]);
      return driverId;
    });
    const assigned = outcomes.filter((o) => o.ok && o.value).map((o) => o.value);
    const distinct = new Set(assigned).size;
    return {
      experiment: 'Concurrent matching', riders, drivers, ms,
      matched: assigned.length, distinct_drivers: distinct,
      told_to_retry: outcomes.filter((o) => o.ok && !o.value).length,
      errors: outcomes.filter((o) => !o.ok).length,
      pass: distinct === assigned.length && assigned.length === Math.min(riders, drivers),
    };
  } finally {
    await dropFixture(f);
  }
}

// Experiment 5: the accept-ride transaction under both isolation levels.
async function isolationLevels({ n = 50 } = {}) {
  return [
    await doubleBooking({ n, isolation: 'READ COMMITTED' }),
    await doubleBooking({ n, isolation: 'SERIALIZABLE' }),
  ];
}

// Experiment 4: EXPLAIN ANALYZE of the matching query with and without the GiST index.
// Everything (20k drivers, dropping the index) happens in one transaction that is rolled back.
async function explainMatching({ drivers = 20000 } = {}) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '3s'");
    const tag = newTag();
    const z = await c.query(
      `INSERT INTO zones (name, boundary) VALUES ($1, ST_GeogFromText('POLYGON((79.30 12.80, 79.36 12.80, 79.36 12.85, 79.30 12.85, 79.30 12.80))'))
       RETURNING zone_id`, [tag]);
    const zoneId = z.rows[0].zone_id;
    await c.query(
      `WITH u AS (
         INSERT INTO users (name, email, password_hash, role)
         SELECT 'Proof driver ' || g, $1 || '-d' || g || '@proof.test', 'x', 'driver' FROM generate_series(1, $2) g
         RETURNING user_id),
       d AS (
         INSERT INTO drivers (user_id, license_number, vehicle_type, plate_number, status, location)
         SELECT user_id, 'P' || substr(md5(user_id::text), 1, 15), 'sedan', 'P' || substr(md5(user_id::text), 16, 10),
                CASE WHEN random() < 0.3 THEN 'available' ELSE 'offline' END,
                ST_SetSRID(ST_MakePoint(79.30 + random() * 0.06, 12.80 + random() * 0.05), 4326)::geography
         FROM u RETURNING user_id)
       INSERT INTO driver_zones SELECT user_id, $3 FROM d`, [tag, drivers, zoneId]);
    const r = await c.query(
      `WITH u AS (INSERT INTO users (name, email, password_hash, role) VALUES ('Proof rider', $1 || '-r@proof.test', 'x', 'rider') RETURNING user_id),
       rr AS (INSERT INTO riders (user_id) SELECT user_id FROM u RETURNING user_id)
       INSERT INTO rides (rider_id, zone_id, pickup_point, drop_point, slot_start, slot_end)
       SELECT user_id, $2, ST_SetSRID(ST_MakePoint(79.33, 12.825), 4326)::geography, ST_SetSRID(ST_MakePoint(79.34, 12.83), 4326)::geography,
              ${SLOT[0]}, ${SLOT[1]} FROM rr RETURNING ride_id`, [tag, zoneId]);
    const params = [zoneId, SLOT[0].slice(1, -1), SLOT[1].slice(1, -1), r.rows[0].ride_id];
    // The row lock is left out here: it does not change the plan, and rows created in this
    // same transaction cannot be locked after the DDL below.
    const sql = MATCH_QUERY.replace('FOR UPDATE OF d SKIP LOCKED', '');
    const explain = async () => {
      const out = await c.query('EXPLAIN (ANALYZE, BUFFERS OFF) ' + sql, params);
      const lines = out.rows.map((x) => x['QUERY PLAN']);
      const exec = lines.find((l) => l.startsWith('Execution Time'));
      return { plan: lines.join('\n'), execution_ms: exec ? Number(exec.match(/([\d.]+) ms/)[1]) : null };
    };
    await c.query('ANALYZE drivers, driver_zones, rides, ride_offers');
    await c.query('DROP INDEX idx_drivers_location');
    const before = await explain();
    await c.query('CREATE INDEX idx_drivers_location ON drivers USING gist (location)');
    await c.query('ANALYZE drivers');
    const after = await explain();
    return {
      experiment: 'Spatial index', drivers, before, after,
      uses_index_after: /idx_drivers_location/.test(after.plan),
      pass: !/idx_drivers_location/.test(before.plan) && /idx_drivers_location/.test(after.plan),
    };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

module.exports = { runVerification, doubleBooking, concurrentMatching, isolationLevels, explainMatching, VERIFY_STEPS };
