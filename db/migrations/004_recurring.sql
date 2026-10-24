-- Script 4: recurring bookings (aggregation over PREFERS) and the multivalued weekdays
CREATE TABLE recurring_bookings (
    booking_id        uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id          uuid         NOT NULL,
    driver_id         uuid         NOT NULL,
    zone_id           integer      NOT NULL,
    pickup_point      geography(Point, 4326) NOT NULL,
    drop_point        geography(Point, 4326) NOT NULL,
    time_of_day       time         NOT NULL,
    duration_minutes  smallint     NOT NULL CHECK (duration_minutes BETWEEN 5 AND 240),
    is_active         boolean      NOT NULL DEFAULT true,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    FOREIGN KEY (rider_id, driver_id, zone_id)
        REFERENCES regular_drivers (rider_id, driver_id, zone_id) ON DELETE CASCADE
);

CREATE TABLE recurring_booking_days (
    booking_id  uuid      NOT NULL REFERENCES recurring_bookings ON DELETE CASCADE,
    weekday     smallint  NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- 1 = Monday
    PRIMARY KEY (booking_id, weekday)
);
