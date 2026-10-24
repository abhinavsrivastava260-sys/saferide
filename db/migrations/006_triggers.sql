-- Script 6: triggers. The audit trigger reads the acting user from app.actor_id,
-- which the API sets at the start of each transaction with SET LOCAL.

-- BR-02 and BR-04: valid status transitions
CREATE FUNCTION check_ride_transition() RETURNS trigger AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    IF (OLD.status, NEW.status) NOT IN (
        ('requested', 'accepted'),  ('requested', 'cancelled'),
        ('accepted', 'arrived'),    ('accepted', 'cancelled'),
        ('arrived', 'in_progress'), ('arrived', 'cancelled'),
        ('in_progress', 'completed')) THEN
        RAISE EXCEPTION 'Invalid ride status transition: % -> %', OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'accepted' AND NOT EXISTS (
        SELECT 1 FROM driver_zones
        WHERE driver_id = NEW.driver_id AND zone_id = NEW.zone_id) THEN
        RAISE EXCEPTION 'Driver does not serve zone %', NEW.zone_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ride_transition BEFORE UPDATE OF status ON rides
    FOR EACH ROW EXECUTE FUNCTION check_ride_transition();

-- FR-16: audit trail
CREATE FUNCTION log_ride_event() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.status = OLD.status THEN
            RETURN NEW;
        END IF;
    END IF;
    INSERT INTO ride_events (ride_id, event_no, from_status, to_status, actor_id)
    SELECT NEW.ride_id,
           COALESCE(MAX(event_no), 0) + 1,
           CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
           NEW.status,
           NULLIF(current_setting('app.actor_id', true), '')::uuid
    FROM ride_events WHERE ride_id = NEW.ride_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ride_audit AFTER INSERT OR UPDATE OF status ON rides
    FOR EACH ROW EXECUTE FUNCTION log_ride_event();

-- BR-05: a regular driver must be earned
CREATE FUNCTION check_regular_eligible() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM rides
                   WHERE rider_id = NEW.rider_id AND driver_id = NEW.driver_id
                     AND zone_id = NEW.zone_id AND status = 'completed') THEN
        RAISE EXCEPTION 'No completed ride with this driver in zone %', NEW.zone_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER regular_eligible BEFORE INSERT ON regular_drivers
    FOR EACH ROW EXECUTE FUNCTION check_regular_eligible();

-- BR-08: chat only between the two participants of an active ride
CREATE FUNCTION check_chat_access() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.ride_id = NEW.ride_id
          AND NEW.sender_id IN (r.rider_id, r.driver_id)
          AND (r.status IN ('accepted', 'arrived', 'in_progress')
               OR r.ended_at > now() - interval '30 minutes')) THEN
        RAISE EXCEPTION 'Sender cannot chat on ride %', NEW.ride_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_access BEFORE INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION check_chat_access();

-- BR-09: only completed rides can be rated
CREATE FUNCTION check_rating_ride() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM rides
                   WHERE ride_id = NEW.ride_id AND status = 'completed') THEN
        RAISE EXCEPTION 'Only completed rides can be rated';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rating_ride BEFORE INSERT ON ratings
    FOR EACH ROW EXECUTE FUNCTION check_rating_ride();
