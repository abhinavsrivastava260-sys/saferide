// Loads demo data around Vellore: 3 zones, 8 drivers, 4 riders and ~10 days of ride history.
// Every user's password is "password". Run with: npm run seed  (it wipes existing data first)
const bcrypt = require('bcryptjs');
const { pool, tx } = require('../src/db');

const box = (w, s, e, n) => `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;
const ZONES = [
  ['Katpadi', box(79.10, 12.95, 79.16, 13.00)],
  ['Gandhi Nagar', box(79.16, 12.95, 79.22, 13.00)],
  ['Vellore Town', box(79.10, 12.90, 79.16, 12.95)],
];
const RIDERS = [
  ['Arjun', 'arjun@x.in', '9000000001', 'upi'],
  ['Sneha', 'sneha@x.in', '9000000002', 'cash'],
  ['Priya', 'priya@x.in', '9000000003', 'card'],
  ['Rahul', 'rahul@x.in', '9000000004', 'upi'],
];
// name, email, licence, vehicle, plate, zones served, lng, lat
const DRIVERS = [
  ['Karthik', 'karthik@x.in', 'TN2320250001', 'sedan', 'TN23AB1234', [1, 2], 79.13, 12.97],
  ['Meena', 'meena@x.in', 'TN2320250002', 'auto', 'TN23CD5678', [1], 79.14, 12.96],
  ['Ravi', 'ravi@x.in', 'TN2320250003', 'bike', 'TN23EF1111', [1, 3], 79.12, 12.955],
  ['Lakshmi', 'lakshmi@x.in', 'TN2320250004', 'hatchback', 'TN23GH2222', [2], 79.19, 12.97],
  ['Suresh', 'suresh@x.in', 'TN2320250005', 'suv', 'TN23IJ3333', [2, 1], 79.17, 12.98],
  ['Divya', 'divya@x.in', 'TN2320250006', 'auto', 'TN23KL4444', [3], 79.13, 12.92],
  ['Manoj', 'manoj@x.in', 'TN2320250007', 'sedan', 'TN23MN5555', [3, 1], 79.14, 12.93],
  ['Anitha', 'anitha@x.in', 'TN2320250008', 'bike', 'TN23OP6666', [2], 79.20, 12.96],
];

const rand = (a, b) => a + Math.random() * (b - a);

async function main() {
  const hash = await bcrypt.hash('password', 10);
  await tx(null, async (c) => {
    await c.query('TRUNCATE users, zones, ride_events, messages, ratings, rides RESTART IDENTITY CASCADE');
    for (const [name, wkt] of ZONES) {
      await c.query('INSERT INTO zones (name, boundary) VALUES ($1, ST_GeogFromText($2))', [name, wkt]);
    }
    const riders = [];
    for (const [name, email, phone, pay] of RIDERS) {
      const { rows } = await c.query(
        `INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,'rider') RETURNING user_id`,
        [name, email, phone, hash]);
      await c.query('INSERT INTO riders (user_id, preferred_payment) VALUES ($1,$2)', [rows[0].user_id, pay]);
      riders.push(rows[0].user_id);
    }
    const drivers = [];
    for (const [name, email, lic, veh, plate, zones, lng, lat] of DRIVERS) {
      const { rows } = await c.query(
        `INSERT INTO users (name, email, password_hash, role, is_online) VALUES ($1,$2,$3,'driver',true) RETURNING user_id`,
        [name, email, hash]);
      const id = rows[0].user_id;
      await c.query(
        `INSERT INTO drivers (user_id, license_number, vehicle_type, plate_number, status, location, last_ping_at)
         VALUES ($1,$2,$3,$4,'available', ST_SetSRID(ST_MakePoint($5,$6),4326)::geography, now())`,
        [id, lic, veh, plate, lng, lat]);
      for (const z of zones) await c.query('INSERT INTO driver_zones VALUES ($1,$2)', [id, z]);
      drivers.push({ id, zones });
    }

    // Ride history: walk each ride through the real lifecycle so triggers write the audit trail.
    for (let i = 0; i < 45; i++) {
      const d = drivers[i % drivers.length];
      const zone = d.zones[i % d.zones.length];
      const rider = i < 6 ? riders[0] : riders[i % riders.length];
      const driver = i < 6 ? drivers[0] : d;
      const z = i < 6 ? 1 : zone;
      const [w, s] = z === 1 ? [79.10, 12.95] : z === 2 ? [79.16, 12.95] : [79.10, 12.90];
      const start = new Date(Date.now() - (i * 5.3 + 2) * 3600e3);
      const end = new Date(start.getTime() + 25 * 60e3);
      const { rows } = await c.query(
        `INSERT INTO rides (rider_id, zone_id, pickup_point, drop_point, slot_start, slot_end, requested_at)
         VALUES ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
                 ST_SetSRID(ST_MakePoint($5,$6),4326)::geography, $7, $8, $7) RETURNING ride_id`,
        [rider, z, rand(w, w + 0.06), rand(s, s + 0.05), rand(w, w + 0.06), rand(s, s + 0.05), start, end]);
      const rideId = rows[0].ride_id;
      if (i % 9 === 4) {
        await c.query(`UPDATE rides SET status='cancelled', ended_at=$2 WHERE ride_id=$1`, [rideId, start]);
        continue;
      }
      await c.query(`UPDATE rides SET driver_id=$2, status='accepted', accepted_at=$3 WHERE ride_id=$1`,
        [rideId, driver.id, start]);
      await c.query(`UPDATE rides SET status='arrived' WHERE ride_id=$1`, [rideId]);
      await c.query(`UPDATE rides SET status='in_progress' WHERE ride_id=$1`, [rideId]);
      await c.query(
        `UPDATE rides r SET status='completed', ended_at=$2,
                fare = fare_for(d.vehicle_type, ST_Distance(r.pickup_point, r.drop_point))
         FROM drivers d WHERE d.user_id = r.driver_id AND r.ride_id=$1`, [rideId, end]);
      await c.query(`INSERT INTO ratings (ride_id, driver_score, rider_score) VALUES ($1,$2,$3)`,
        [rideId, 3 + (i % 3), 4 + (i % 2)]);
    }
    // Arjun has completed rides with Karthik in Katpadi, so Karthik can be his regular driver (BR-05).
    await c.query('INSERT INTO regular_drivers (rider_id, driver_id, zone_id) VALUES ($1,$2,1)', [riders[0], drivers[0].id]);
    // History rows were written by the system, so the audit events have no actor.
    await c.query('UPDATE ride_events SET event_time = r.requested_at FROM rides r WHERE r.ride_id = ride_events.ride_id');
  });
  console.log('Seeded. Log in as arjun@x.in (rider) or karthik@x.in (driver), password "password".');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
