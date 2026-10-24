#!/usr/bin/env bash
# Installs PostgreSQL + PostGIS inside the codespace (if missing), starts it,
# and creates the ridebook database with user postgres / password postgres.
# Runs as root in the codespace; elsewhere it uses sudo -n so it fails instead of waiting for a password.
set -e
if [ "$(id -u)" -eq 0 ]; then SUDO=""; AS_PG="runuser -u postgres --"; else SUDO="sudo -n"; AS_PG="sudo -n -u postgres"; fi

if ! command -v pg_ctlcluster >/dev/null 2>&1 || ! ls /usr/share/postgresql/*/extension/postgis.control >/dev/null 2>&1; then
  echo "Installing PostgreSQL and PostGIS (first time only)..."
  $SUDO apt-get update -qq || echo "apt-get update reported errors (often a third-party repo); continuing"
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq postgresql postgresql-contrib >/dev/null
  PGV=$(ls /usr/lib/postgresql | sort -n | tail -1)
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "postgresql-$PGV-postgis-3" >/dev/null
fi

$SUDO service postgresql start
for i in $(seq 1 30); do $AS_PG psql -qAtc "select 1" >/dev/null 2>&1 && break; sleep 1; done
$AS_PG psql -qc "ALTER USER postgres PASSWORD 'postgres';"
$AS_PG psql -qAtc "SELECT 1 FROM pg_database WHERE datname = 'ridebook'" | grep -q 1 \
  || $AS_PG createdb ridebook
echo "PostgreSQL is running with database 'ridebook'."
