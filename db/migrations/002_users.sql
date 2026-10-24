-- Script 2: users, riders and drivers (disjoint, total specialization of USER)
CREATE TABLE users (
    user_id        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    name           varchar(80)   NOT NULL,
    email          varchar(120)  NOT NULL UNIQUE,
    phone          varchar(15)   UNIQUE,
    password_hash  text          NOT NULL,
    role           varchar(6)    NOT NULL CHECK (role IN ('rider', 'driver')),
    is_online      boolean       NOT NULL DEFAULT false,
    last_seen_at   timestamptz,
    created_at     timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (user_id, role)
);

CREATE TABLE riders (
    user_id            uuid        PRIMARY KEY,
    role               varchar(6)  NOT NULL DEFAULT 'rider' CHECK (role = 'rider'),
    preferred_payment  varchar(4)  NOT NULL DEFAULT 'cash'
                       CHECK (preferred_payment IN ('cash', 'card', 'upi')),
    FOREIGN KEY (user_id, role) REFERENCES users (user_id, role) ON DELETE CASCADE
);

CREATE TABLE drivers (
    user_id         uuid         PRIMARY KEY,
    role            varchar(6)   NOT NULL DEFAULT 'driver' CHECK (role = 'driver'),
    license_number  varchar(20)  NOT NULL UNIQUE,
    vehicle_type    varchar(10)  NOT NULL
                    CHECK (vehicle_type IN ('bike', 'auto', 'hatchback', 'sedan', 'suv')),
    plate_number    varchar(12)  NOT NULL UNIQUE,
    status          varchar(9)   NOT NULL DEFAULT 'offline'
                    CHECK (status IN ('offline', 'available', 'busy')),
    location        geography(Point, 4326),
    last_ping_at    timestamptz,
    FOREIGN KEY (user_id, role) REFERENCES users (user_id, role) ON DELETE CASCADE
);
