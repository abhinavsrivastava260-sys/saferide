-- Script 7: indexes
CREATE INDEX idx_drivers_location   ON drivers USING gist (location);
CREATE INDEX idx_drivers_available  ON drivers (status) WHERE status = 'available';
CREATE INDEX idx_zones_boundary     ON zones   USING gist (boundary);
CREATE INDEX idx_driver_zones_zone  ON driver_zones (zone_id);
CREATE INDEX idx_rides_rider_time   ON rides (rider_id, requested_at DESC);
CREATE INDEX idx_rides_driver_time  ON rides (driver_id, slot_start);
CREATE INDEX idx_messages_ride      ON messages (ride_id, created_at DESC);
CREATE INDEX idx_offers_expiry      ON ride_offers (expires_at) WHERE status = 'pending';
CREATE UNIQUE INDEX one_pending_offer_per_ride
    ON ride_offers (ride_id) WHERE status = 'pending';                       -- BR-07
