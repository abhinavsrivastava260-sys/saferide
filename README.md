# SafeRide: a concurrency-safe ride booking database

DBMS project (VIT Vellore, Project 04) by Rishi Raj Singh and Abhinav Srivastava.

A ride booking website where PostgreSQL itself guarantees that a driver is never
double-booked, that a ride moves only through valid states, and that riders can keep
regular drivers who get offered their bookings first. The website (Node.js, Express,
Socket.io and a plain HTML/JS client) exercises those rules; it does not re-implement them.

## Run it in the browser (no installs): GitHub Codespaces

1. Open the repository on GitHub, click **Code → Codespaces → Create codespace on main**.
2. Wait for setup to finish (it installs PostgreSQL with PostGIS inside the codespace, the npm packages and the demo data).
3. In the terminal, run `npm start`, then open port 3000 from the **Ports** tab.

If setup did not finish, run it by hand: `bash .devcontainer/setup-db.sh && npm install && npm run setup && npm start`.

The same `.devcontainer` folder also works in desktop VS Code with Docker Desktop and the *Dev Containers*
extension: open the folder and choose **Reopen in Container**. On any Debian or Ubuntu machine,
`bash .devcontainer/setup-db.sh` installs and starts the database for you.

## Run it on your own machine

You need **Node.js 18+** and **PostgreSQL 14+ with PostGIS**.
On Windows, install PostgreSQL from postgresql.org and tick *PostGIS* in Stack Builder.
On macOS, `brew install postgresql@16 postgis`. On Ubuntu, `sudo apt install postgresql postgresql-16-postgis-3`.

```bash
createdb ridebook                # or: psql -U postgres -c "CREATE DATABASE ridebook"
cp .env.example .env             # then edit DATABASE_URL if your password differs
npm install
npm run setup                    # applies db/migrations in order, then loads demo data
npm start                        # http://localhost:3000
```

Demo logins (password `password`): riders `abc@x.in`, `sneha@x.in`, `priya@x.in`, `rahul@x.in`;
drivers `xyz@x.in`, `meena@x.in`, `ravi@x.in` and five more. The admin page is
`/admin.html` with the key from `.env` (default `admin123`). The map tiles come from
OpenStreetMap, so the browser needs internet access.

To try a full ride, open two browser windows (one normal, one private): log in as abc in
one and xyz in the other. abc clicks the map for pickup and drop and requests a ride;
xyz gets a 30 second offer (xyz is abc's regular driver in Katpadi, so he is asked first).

## What is where

| Path | What it holds |
| --- | --- |
| `db/migrations/001-007` | The seven scripts from Section 5.4 of the proposal: tables, the `no_driver_overlap` exclusion constraint, triggers and indexes |
| `db/migrations/008_views.sql` | `ride_details` and `driver_ratings` views (derived values are computed, not stored) and the `fare_for` rule |
| `src/rides.js` | Regular-driver-first matching, the Section 5.5 matching query, offers, accept/decline, status changes, scheduled slots |
| `src/jobs.js` | Background "System" actor: expires 30 second offers, retries waiting rides, creates recurring rides for the next 7 days |
| `src/proofs.js` | Section 5.6 verification tests and the Section 6 experiments |
| `src/routes/` | REST API: `auth`, `zones`, `driver`, `rides` (chat and ratings too), `regulars` (regular drivers and weekly bookings), `admin` |
| `src/socket.js` | Live delivery only (user to socket map). Ride state is never held in memory |
| `public/` | `index.html` (rider and driver app) and `admin.html` (overview, proofs, reports, zones, table browser) |

## Where each rule lives

| Rule | Enforced by | Seen in the app |
| --- | --- | --- |
| BR-01 no overlapping rides per driver | `EXCLUDE USING gist (driver_id WITH =, tstzrange(slot_start, slot_end) WITH &&)` | Booking an overlapping slot returns "Driver already has a ride in an overlapping time slot" |
| BR-02 valid status path | `check_ride_transition` trigger | Driver buttons follow accepted → arrived → in progress → completed |
| BR-03 driver once accepted | CHECK on `rides` | |
| BR-04 driver serves the zone | same trigger, on requested → accepted | Drivers pick zones on the Zones tab |
| BR-05 regular driver must be earned | `check_regular_eligible` trigger | "Add as my regular driver" after a completed ride |
| BR-06 recurring only with a regular | composite FK `recurring_bookings → regular_drivers` | Weekly booking form lists only regulars |
| BR-07 one pending offer per ride | partial unique index `one_pending_offer_per_ride` | |
| BR-08 chat only between the two, until 30 min after | `check_chat_access` trigger | Chat box on the ride card |
| BR-09 rating once, 1 to 5, completed only | CHECK, UNIQUE (ride_id), `check_rating_ride` trigger | Stars after the trip |
| BR-10 rider xor driver | role column + composite FK (user_id, role) | |
| BR-11 completed ride has a fare | CHECK on `rides` | Fare is set by `fare_for` on completion |
| FR-16 audit trail | `log_ride_event` trigger; the API sets `app.actor_id` with `SET LOCAL` | "Status history" on every ride card |

## Proofs

`npm run proofs` (or the **Proofs** tab on the admin page) runs:

* **Section 5.6 verification**: Tests 1 to 5 from the proposal plus 9 extra break attempts (one per business rule), inside one transaction that is rolled back.
* **Experiment 1**: 100 simultaneous accepts for one driver and slot. Result here: 1 succeeded, 99 rejected by `no_driver_overlap`.
* **Experiment 3**: 50 riders and 10 drivers at once. Result: 10 matched to 10 distinct drivers, 40 told to retry.
* **Experiment 4**: EXPLAIN ANALYZE over 20,000 drivers. Result: about 24 ms without the GiST index, about 0.4 ms with it.
* **Experiment 5**: the accept transaction under READ COMMITTED and SERIALIZABLE (both keep exactly one booking).
* **Experiment 6** (manual): stop and restart the server mid-ride; the ride is still in the same status.

The concurrency experiments create their own `proof-…` zone and users and delete them afterwards.

## Choices made while building

* **Matching query.** The zone condition is written as `EXISTS (… driver_zones …)` instead of a JOIN. The result is the same, but the planner can then walk the GiST index nearest-first and stop at the first free driver, which is what makes Experiment 4 show the index being used.
* **Offers mark the driver busy.** Creating an offer sets the driver to `busy` in the same transaction, so a request that starts after it commits cannot pick the same driver. Decline, expiry, completion and cancellation put the driver back to `available`.
* **Scheduled and weekly rides** with a regular driver are confirmed straight away (regular drivers are trusted), but still go through requested → accepted, so the zone trigger and the exclusion constraint check them. A weekly slot that clashes is kept as a cancelled ride so the clash is on record.
* **booking_type**: `instant` for normal matching, `regular` when the regular driver got the offer, `scheduled` for future and weekly slots.
* **Administrator** is not a user role (BR-10 says every user is a rider or a driver), so the admin page uses a key from `.env`.
