-- Script 5: rides, offers, audit trail, chat and ratings
CREATE TABLE rides (
    ride_id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id              uuid         NOT NULL REFERENCES riders (user_id),
    driver_id             uuid         REFERENCES drivers (user_id),
    zone_id               integer      NOT NULL REFERENCES zones (zone_id),
    recurring_booking_id  uuid         REFERENCES recurring_bookings (booking_id)
                                       ON DELETE SET NULL,
    pickup_point          geography(Point, 4326) NOT NULL,
    drop_point            geography(Point, 4326) NOT NULL,
    booking_type          varchar(9)   NOT NULL DEFAULT 'instant'
                          CHECK (booking_type IN ('instant', 'regular', 'scheduled')),
    status                varchar(11)  NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested', 'accepted', 'arrived',
                                            'in_progress', 'completed', 'cancelled')),
    fare                  numeric(8,2) CHECK (fare >= 0),
    requested_at          timestamptz  NOT NULL DEFAULT now(),
    accepted_at           timestamptz,
    ended_at              timestamptz,
    slot_start            timestamptz  NOT NULL,
    slot_end              timestamptz  NOT NULL,
    CHECK (slot_end > slot_start),
    CHECK (driver_id IS NOT NULL OR status IN ('requested', 'cancelled')),    -- BR-03
    CHECK (status <> 'completed' OR fare IS NOT NULL),                        -- BR-11
    -- BR-01: the heart of the project
    CONSTRAINT no_driver_overlap EXCLUDE USING gist (
        driver_id WITH =,
        tstzrange(slot_start, slot_end) WITH &&
    ) WHERE (driver_id IS NOT NULL AND status IN ('accepted', 'arrived', 'in_progress'))
);

CREATE TABLE ride_offers (
    ride_id     uuid        NOT NULL REFERENCES rides (ride_id)     ON DELETE CASCADE,
    driver_id   uuid        NOT NULL REFERENCES drivers (user_id)   ON DELETE CASCADE,
    status      varchar(8)  NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    offered_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    PRIMARY KEY (ride_id, driver_id),
    CHECK (expires_at > offered_at)
);

-- Weak entity RIDE_EVENT, identified by (ride_id, event_no)
CREATE TABLE ride_events (
    ride_id      uuid         NOT NULL REFERENCES rides (ride_id) ON DELETE CASCADE,
    event_no     integer      NOT NULL,
    from_status  varchar(11),
    to_status    varchar(11)  NOT NULL,
    actor_id     uuid         REFERENCES users (user_id) ON DELETE SET NULL,
    event_time   timestamptz  NOT NULL DEFAULT now(),
    PRIMARY KEY (ride_id, event_no)
);

CREATE TABLE messages (
    message_id  bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id     uuid          NOT NULL REFERENCES rides (ride_id) ON DELETE CASCADE,
    sender_id   uuid          NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    content     varchar(2000),
    media_url   text,
    media_type  varchar(20),
    status      varchar(9)    NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent', 'delivered', 'read')),
    created_at  timestamptz   NOT NULL DEFAULT now(),
    CHECK (content IS NOT NULL OR media_url IS NOT NULL)
);

CREATE TABLE ratings (
    rating_id     integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id       uuid         NOT NULL UNIQUE REFERENCES rides (ride_id) ON DELETE CASCADE,
    driver_score  smallint     CHECK (driver_score BETWEEN 1 AND 5),   -- rider rates driver
    rider_score   smallint     CHECK (rider_score  BETWEEN 1 AND 5),   -- driver rates rider
    rated_at      timestamptz  NOT NULL DEFAULT now()
);
