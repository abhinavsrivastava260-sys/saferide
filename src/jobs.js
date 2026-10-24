// Background jobs (the "System" actor): expire unanswered offers, keep searching for
// waiting rides, and create the individual rides of recurring bookings.
const config = require('./config');
const { tx, query } = require('./db');
const { emitTo } = require('./socket');
const rides = require('./rides');

async function expireOffers() {
  const expired = await tx(null, async (c) => {
    const { rows } = await c.query(
      `UPDATE ride_offers SET status = 'expired'
       WHERE status = 'pending' AND expires_at < now() RETURNING ride_id, driver_id`);
    for (const r of rows) await rides.releaseDriver(c, r.driver_id);
    return rows;
  });
  for (const r of expired) {
    emitTo(r.driver_id, 'offer:gone', { ride_id: r.ride_id, reason: 'expired' });
    await rides.rematch(r.ride_id);
  }
}

// Rides still "requested" with no live offer: try again, and give up after a few minutes.
async function retryWaiting() {
  const { rows } = await query(
    `SELECT r.ride_id, r.requested_at < now() - make_interval(mins => $1) AS too_old
     FROM rides r
     JOIN zones z ON z.zone_id = r.zone_id
     WHERE r.status = 'requested' AND r.booking_type <> 'scheduled'
       AND z.name NOT LIKE 'proof-%'   -- zones created by the proof experiments are left alone
       AND NOT EXISTS (SELECT 1 FROM ride_offers o WHERE o.ride_id = r.ride_id AND o.status = 'pending')`,
    [config.searchTimeoutMinutes]);
  for (const r of rows) {
    if (r.too_old) {
      await tx(null, (c) => c.query(
        `UPDATE rides SET status = 'cancelled', ended_at = now() WHERE ride_id = $1 AND status = 'requested'`, [r.ride_id]));
      const ride = await rides.getRide(r.ride_id);
      emitTo(ride.rider_id, 'ride:update', { ride, note: 'No driver was free, so the request was cancelled. Please try again.' });
    } else {
      await rides.rematch(r.ride_id);
    }
  }
}

// Creates the rides of the next 7 days for active recurring bookings. A slot that clashes
// with another booking of the same driver is kept as a cancelled ride, so the clash is on record.
async function generateRecurringRides(bookingId = null) {
  const { rows } = await query(
    `SELECT b.booking_id, b.rider_id, b.driver_id, b.zone_id, b.pickup_point, b.drop_point, b.duration_minutes,
            (g.d::date + b.time_of_day) AT TIME ZONE $1 AS slot_start
     FROM recurring_bookings b
     JOIN recurring_booking_days bd USING (booking_id)
     CROSS JOIN LATERAL generate_series((now() AT TIME ZONE $1)::date, (now() AT TIME ZONE $1)::date + 6, interval '1 day') AS g(d)
     WHERE b.is_active
       AND ($2::uuid IS NULL OR b.booking_id = $2)
       AND extract(isodow FROM g.d) = bd.weekday
       AND (g.d::date + b.time_of_day) AT TIME ZONE $1 > now()
       AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.recurring_booking_id = b.booking_id
                       AND r.slot_start = (g.d::date + b.time_of_day) AT TIME ZONE $1)
     ORDER BY slot_start`, [config.tz, bookingId]);
  let created = 0;
  for (const b of rows) {
    const args = {
      riderId: b.rider_id, driverId: b.driver_id, zoneId: b.zone_id, pickup: b.pickup_point,
      drop: b.drop_point, start: b.slot_start, minutes: b.duration_minutes, bookingId: b.booking_id,
    };
    try {
      await tx(null, (c) => rides.insertScheduled(c, args));
      created++;
    } catch (err) {
      if (err.code !== '23P01') throw err;
      await tx(null, async (c) => {
        const r = await c.query(
          `INSERT INTO rides (rider_id, zone_id, pickup_point, drop_point, booking_type, slot_start, slot_end, recurring_booking_id)
           VALUES ($1,$2,$3,$4,'scheduled',$5,$5::timestamptz + make_interval(mins => $6),$7) RETURNING ride_id`,
          [b.rider_id, b.zone_id, b.pickup_point, b.drop_point, b.slot_start, b.duration_minutes, b.booking_id]);
        await c.query(`UPDATE rides SET status = 'cancelled', ended_at = now() WHERE ride_id = $1`, [r.rows[0].ride_id]);
      });
    }
  }
  return created;
}

function start() {
  const safe = (fn) => () => fn().catch((e) => console.error(`[job ${fn.name}]`, e.message));
  setInterval(safe(expireOffers), 2000);
  setInterval(safe(retryWaiting), 5000);
  setInterval(safe(generateRecurringRides), 60 * 60e3);
  safe(generateRecurringRides)();
}

module.exports = { start, expireOffers, retryWaiting, generateRecurringRides };
