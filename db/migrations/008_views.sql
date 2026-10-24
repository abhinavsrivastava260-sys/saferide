-- Script 8 (added for the website): read-only views and the fare rule.
-- Derived values (distance, average rating) are computed here, never stored.

-- Simple fare rule from the scope section: base amount plus a rate per kilometre.
CREATE FUNCTION fare_for(vehicle varchar, metres double precision) RETURNS numeric AS $$
    SELECT round((CASE vehicle
                    WHEN 'bike'      THEN 20 + 6  * metres / 1000
                    WHEN 'auto'      THEN 30 + 10 * metres / 1000
                    WHEN 'hatchback' THEN 40 + 12 * metres / 1000
                    WHEN 'sedan'     THEN 50 + 14 * metres / 1000
                    ELSE                  60 + 18 * metres / 1000
                  END)::numeric, 2);
$$ LANGUAGE sql IMMUTABLE;

CREATE VIEW ride_details AS
SELECT r.ride_id, r.rider_id, ru.name AS rider_name, r.driver_id, du.name AS driver_name,
       d.vehicle_type, d.plate_number, r.zone_id, z.name AS zone_name,
       r.recurring_booking_id, r.booking_type, r.status, r.fare,
       r.requested_at, r.accepted_at, r.ended_at, r.slot_start, r.slot_end,
       ST_Y(r.pickup_point::geometry) AS pickup_lat, ST_X(r.pickup_point::geometry) AS pickup_lng,
       ST_Y(r.drop_point::geometry)   AS drop_lat,   ST_X(r.drop_point::geometry)   AS drop_lng,
       round((ST_Distance(r.pickup_point, r.drop_point) / 1000)::numeric, 2) AS distance_km,
       rt.driver_score, rt.rider_score
FROM rides r
JOIN users ru ON ru.user_id = r.rider_id
JOIN zones z  ON z.zone_id  = r.zone_id
LEFT JOIN users du   ON du.user_id = r.driver_id
LEFT JOIN drivers d  ON d.user_id  = r.driver_id
LEFT JOIN ratings rt ON rt.ride_id = r.ride_id;

CREATE VIEW driver_ratings AS
SELECT d.user_id AS driver_id,
       round(avg(rt.driver_score), 2) AS avg_rating,
       count(rt.driver_score)         AS rating_count
FROM drivers d
LEFT JOIN rides r    ON r.driver_id = d.user_id AND r.status = 'completed'
LEFT JOIN ratings rt ON rt.ride_id  = r.ride_id
GROUP BY d.user_id;
