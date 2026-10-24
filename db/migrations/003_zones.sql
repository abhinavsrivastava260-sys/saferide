-- Script 3: zones and regular drivers
CREATE TABLE zones (
    zone_id   integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name      varchar(60)  NOT NULL UNIQUE,
    boundary  geography(Polygon, 4326) NOT NULL
);

CREATE TABLE driver_zones (
    driver_id  uuid     NOT NULL REFERENCES drivers (user_id) ON DELETE CASCADE,
    zone_id    integer  NOT NULL REFERENCES zones (zone_id)   ON DELETE CASCADE,
    PRIMARY KEY (driver_id, zone_id)
);

-- Ternary PREFERS relationship (rider, driver, zone)
CREATE TABLE regular_drivers (
    rider_id   uuid         NOT NULL REFERENCES riders (user_id) ON DELETE CASCADE,
    driver_id  uuid         NOT NULL,
    zone_id    integer      NOT NULL,
    added_at   timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY (rider_id, driver_id, zone_id),
    FOREIGN KEY (driver_id, zone_id) REFERENCES driver_zones (driver_id, zone_id)
        ON DELETE CASCADE
);
