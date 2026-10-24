const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });

// Runs fn inside one transaction. The acting user is stored with SET LOCAL so
// the audit trigger (log_ride_event) can record who made each status change.
async function tx(actorId, fn, { isolation } = {}) {
  const client = await pool.connect();
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId || '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const query = (text, params) => pool.query(text, params);

// Turns database rule violations into readable HTTP errors.
function describePgError(err) {
  switch (err.code) {
    case '23P01':
      return { status: 409, message: 'Driver already has a ride in an overlapping time slot (no_driver_overlap)' };
    case 'P0001':
      return { status: 400, message: err.message };
    case '23505':
      return { status: 409, message: `Duplicate value (${err.constraint || 'unique constraint'})` };
    case '23503':
      return { status: 400, message: `Referenced row does not exist (${err.constraint || 'foreign key'})` };
    case '23514':
      return { status: 400, message: `Check constraint failed (${err.constraint || 'check'})` };
    default:
      return null;
  }
}

module.exports = { pool, tx, query, describePgError };
