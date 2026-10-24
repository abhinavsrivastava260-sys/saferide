// Ride matching and lifecycle. All the safety lives in the database; this file
// just runs the right statements inside transactions and tells people what happened.
const config = require('./config');
const { tx, query } = require('./db');
const { emitTo } = require('./socket');
const { HttpError } = require('./http');

const point = (i) => `ST_SetSRID(ST_MakePoint($${i}, $${i + 1}), 4326)::geography`;

async function getRide(rideId, client = { query }) {
  const { rows } = await client.query('SELECT * FROM ride_details WHERE ride_id = $1', [rideId]);
  return rows[0];
}

async function zoneFor(client, lng, lat) {
  const { rows } = await client.query(
    `SELECT zone_id, name FROM zones WHERE ST_Covers(boundary, ${point(1)}) ORDER BY zone_id LIMIT 1`, [lng, lat]);
  if (!rows[0]) throw new HttpError(400, 'That pickup point is outside every service zone');
  return rows[0];
}

// Instant slot: from now until the estimated end (25 km/h plus 5 minutes, at least 10 minutes).
async function estimateMinutes(client, p, d) {
  const { rows } = await client.query(`SELECT ST_Distance(${point(1)}, ${point(3)}) AS m`, [p.lng, p.lat, d.lng, d.lat]);
  return Math.max(10, Math.round((rows[0].m / 1000 / 25) * 60 + 5));
}

// FR-12: the rider's regular driver for this zone gets the first offer.
const REGULAR_QUERY = `
  SELECT d.user_id
  FROM regular_drivers rd
  JOIN drivers d ON d.user_id = rd.driver_id
  WHERE rd.rider_id = $1 AND rd.zone_id = $2
    AND d.status = 'available'
    AND NOT EXISTS (SELECT 1 FROM ride_offers o WHERE o.ride_id = $5 AND o.driver_id = d.user_id)
    AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = d.user_id
          AND r.status IN ('accepted', 'arrived', 'in_progress')
          AND tstzrange(r.slot_start, r.slot_end) && tstzrange($3, $4))
  ORDER BY d.location <-> (SELECT pickup_point FROM rides WHERE ride_id = $5)
  LIMIT 1
  FOR UPDATE OF d SKIP LOCKED`;

// Section 5.5: the matching query. SKIP LOCKED makes simultaneous requests take different drivers.
// The zone test is written as EXISTS rather than a JOIN (same result, since driver_zones has one
// row per driver and zone) so the planner can walk the GiST index nearest-first and stop at LIMIT 1.
const MATCH_QUERY = `
  SELECT d.user_id
  FROM drivers d
  WHERE EXISTS (SELECT 1 FROM driver_zones dz WHERE dz.driver_id = d.user_id AND dz.zone_id = $1)
    AND d.status = 'available'
    AND NOT EXISTS (SELECT 1 FROM ride_offers o WHERE o.ride_id = $4 AND o.driver_id = d.user_id)
    AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = d.user_id
          AND r.status IN ('accepted', 'arrived', 'in_progress')
          AND tstzrange(r.slot_start, r.slot_end) && tstzrange($2, $3))
  ORDER BY d.location <-> (SELECT pickup_point FROM rides WHERE ride_id = $4)
  LIMIT 1
  FOR UPDATE OF d SKIP LOCKED`;

// Picks a driver and creates a 30 second offer. Marking the driver busy in the same
// transaction means a request that starts after this commit can no longer see them as free.
async function offerToNextDriver(client, ride) {
  let driverId = null;
  let viaRegular = false;
  const reg = await client.query(REGULAR_QUERY, [ride.rider_id, ride.zone_id, ride.slot_start, ride.slot_end, ride.ride_id]);
  if (reg.rows[0]) {
    driverId = reg.rows[0].user_id;
    viaRegular = true;
  } else {
    const m = await client.query(MATCH_QUERY, [ride.zone_id, ride.slot_start, ride.slot_end, ride.ride_id]);
    driverId = m.rows[0]?.user_id || null;
  }
  if (!driverId) return null;
  await client.query(
    `INSERT INTO ride_offers (ride_id, driver_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [ride.ride_id, driverId, config.offerSeconds]);
  await client.query(`UPDATE drivers SET status = 'busy' WHERE user_id = $1`, [driverId]);
  if (viaRegular) await client.query(`UPDATE rides SET booking_type = 'regular' WHERE ride_id = $1`, [ride.ride_id]);
  return { driverId, viaRegular };
}

async function notifyOffer(rideId, offer) {
  if (!offer) return;
  const ride = await getRide(rideId);
  const { rows } = await query('SELECT expires_at FROM ride_offers WHERE ride_id = $1 AND driver_id = $2', [rideId, offer.driverId]);
  emitTo(offer.driverId, 'offer:new', { ride, expires_at: rows[0].expires_at, via_regular: offer.viaRegular });
  emitTo(ride.rider_id, 'ride:update', { ride, note: offer.viaRegular ? 'Offered to your regular driver first' : 'Offered to the nearest driver' });
}

async function requestInstant(riderId, pickup, drop) {
  const { ride, offer } = await tx(riderId, async (c) => {
    const zone = await zoneFor(c, pickup.lng, pickup.lat);
    const minutes = await estimateMinutes(c, pickup, drop);
    const { rows } = await c.query(
      `INSERT INTO rides (rider_id, zone_id, pickup_point, drop_point, booking_type, slot_start, slot_end)
       VALUES ($1, $2, ${point(3)}, ${point(5)}, 'instant', now(), now() + make_interval(mins => $7))
       RETURNING *`,
      [riderId, zone.zone_id, pickup.lng, pickup.lat, drop.lng, drop.lat, minutes]);
    return { ride: rows[0], offer: await offerToNextDriver(c, rows[0]) };
  });
  await notifyOffer(ride.ride_id, offer);
  return { ride: await getRide(ride.ride_id), matched: !!offer };
}

// Tries the next driver for a ride that is still waiting (after a decline or an expiry).
async function rematch(rideId) {
  const offer = await tx(null, async (c) => {
    const { rows } = await c.query(`SELECT * FROM rides WHERE ride_id = $1 AND status = 'requested' FOR UPDATE`, [rideId]);
    if (!rows[0]) return null;
    const pending = await c.query(`SELECT 1 FROM ride_offers WHERE ride_id = $1 AND status = 'pending'`, [rideId]);
    if (pending.rows[0]) return null;
    return offerToNextDriver(c, rows[0]);
  });
  if (offer) await notifyOffer(rideId, offer);
  else {
    const ride = await getRide(rideId);
    if (ride?.status === 'requested') emitTo(ride.rider_id, 'ride:update', { ride, note: 'Still looking for a free driver…' });
  }
}

// A driver goes back to available once they hold no pending offer and no trip that is happening now.
async function releaseDriver(client, driverId) {
  await client.query(
    `UPDATE drivers d SET status = 'available'
     WHERE d.user_id = $1 AND d.status = 'busy'
       AND NOT EXISTS (SELECT 1 FROM ride_offers o WHERE o.driver_id = d.user_id AND o.status = 'pending')
       AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = d.user_id
                       AND r.status IN ('accepted', 'arrived', 'in_progress') AND r.slot_start <= now())`,
    [driverId]);
}

async function acceptOffer(driverId, rideId) {
  await tx(driverId, async (c) => {
    const { rows } = await c.query(
      `SELECT status, expires_at < now() AS expired FROM ride_offers WHERE ride_id = $1 AND driver_id = $2 FOR UPDATE`,
      [rideId, driverId]);
    const offer = rows[0];
    if (!offer) throw new HttpError(404, 'No such offer');
    if (offer.status !== 'pending' || offer.expired) throw new HttpError(409, 'This offer is no longer open');
    await c.query(`UPDATE ride_offers SET status = 'accepted' WHERE ride_id = $1 AND driver_id = $2`, [rideId, driverId]);
    const upd = await c.query(
      `UPDATE rides SET driver_id = $2, status = 'accepted', accepted_at = now()
       WHERE ride_id = $1 AND status = 'requested' RETURNING ride_id`, [rideId, driverId]);
    if (!upd.rows[0]) throw new HttpError(409, 'The rider cancelled this ride');
  });
  const ride = await getRide(rideId);
  emitTo(ride.rider_id, 'ride:update', { ride, note: `${ride.driver_name} accepted your ride` });
  return ride;
}

async function declineOffer(driverId, rideId) {
  await tx(driverId, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE ride_offers SET status = 'declined' WHERE ride_id = $1 AND driver_id = $2 AND status = 'pending'`,
      [rideId, driverId]);
    if (!rowCount) throw new HttpError(409, 'This offer is no longer pending');
    await releaseDriver(c, driverId);
  });
  await rematch(rideId);
}

const ALLOWED = {
  driver: ['arrived', 'in_progress', 'completed', 'cancelled'],
  rider: ['cancelled'],
};

async function changeStatus(user, rideId, status) {
  if (!ALLOWED[user.role].includes(status)) throw new HttpError(403, `A ${user.role} cannot set status ${status}`);
  await tx(user.id, async (c) => {
    const { rows } = await c.query(`SELECT * FROM rides WHERE ride_id = $1 FOR UPDATE`, [rideId]);
    const ride = rows[0];
    if (!ride || ![ride.rider_id, ride.driver_id].includes(user.id)) throw new HttpError(404, 'Ride not found');
    if (status === 'completed') {
      await c.query(
        `UPDATE rides r SET status = 'completed', ended_at = now(),
                fare = fare_for(d.vehicle_type, ST_Distance(r.pickup_point, r.drop_point))
         FROM drivers d WHERE d.user_id = r.driver_id AND r.ride_id = $1`, [rideId]);
    } else if (status === 'cancelled') {
      await c.query(`UPDATE rides SET status = 'cancelled', ended_at = now() WHERE ride_id = $1`, [rideId]);
      const off = await c.query(
        `UPDATE ride_offers SET status = 'expired' WHERE ride_id = $1 AND status = 'pending' RETURNING driver_id`, [rideId]);
      for (const o of off.rows) await releaseDriver(c, o.driver_id);
    } else {
      await c.query(`UPDATE rides SET status = $2 WHERE ride_id = $1`, [rideId, status]);
    }
    if (ride.driver_id && ['completed', 'cancelled'].includes(status)) await releaseDriver(c, ride.driver_id);
  });
  const ride = await getRide(rideId);
  const other = user.id === ride.rider_id ? ride.driver_id : ride.rider_id;
  emitTo(other, 'ride:update', { ride, note: `Ride is now ${status.replace('_', ' ')}` });
  emitTo(user.id, 'ride:update', { ride });
  if (status === 'cancelled' && !ride.driver_id) {
    const { rows } = await query(`SELECT driver_id FROM ride_offers WHERE ride_id = $1 AND status = 'expired'`, [rideId]);
    rows.forEach((r) => emitTo(r.driver_id, 'offer:gone', { ride_id: rideId }));
  }
  return ride;
}

// FR-13: a future slot with a regular driver. Inserted as requested and then accepted,
// so the transition trigger (zone check) and the exclusion constraint (overlap) both apply.
async function insertScheduled(c, { riderId, driverId, zoneId, pickup, drop, start, minutes, bookingId = null }) {
  const { rows } = await c.query(
    `INSERT INTO rides (rider_id, zone_id, pickup_point, drop_point, booking_type, slot_start, slot_end, recurring_booking_id)
     VALUES ($1, $2, $3, $4, 'scheduled', $5, $5::timestamptz + make_interval(mins => $6), $7) RETURNING ride_id`,
    [riderId, zoneId, pickup, drop, start, minutes, bookingId]);
  await c.query(`UPDATE rides SET driver_id = $2, status = 'accepted', accepted_at = now() WHERE ride_id = $1`,
    [rows[0].ride_id, driverId]);
  return rows[0].ride_id;
}

async function bookScheduled(riderId, { driverId, pickup, drop, start, minutes }) {
  const rideId = await tx(riderId, async (c) => {
    const zone = await zoneFor(c, pickup.lng, pickup.lat);
    const reg = await c.query(`SELECT 1 FROM regular_drivers WHERE rider_id = $1 AND driver_id = $2 AND zone_id = $3`,
      [riderId, driverId, zone.zone_id]);
    if (!reg.rows[0]) throw new HttpError(400, `This driver is not one of your regular drivers in ${zone.name}`);
    const p = await c.query(`SELECT ${point(1)} AS p, ${point(3)} AS d`, [pickup.lng, pickup.lat, drop.lng, drop.lat]);
    return insertScheduled(c, { riderId, driverId, zoneId: zone.zone_id, pickup: p.rows[0].p, drop: p.rows[0].d, start, minutes });
  });
  const ride = await getRide(rideId);
  emitTo(driverId, 'ride:update', { ride, note: `${ride.rider_name} booked you for ${new Date(ride.slot_start).toLocaleString()}` });
  return ride;
}

module.exports = {
  getRide, zoneFor, requestInstant, rematch, releaseDriver, acceptOffer, declineOffer,
  changeStatus, bookScheduled, insertScheduled, MATCH_QUERY,
};
