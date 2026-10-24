// Applies db/migrations/*.sql in order, each once, recording them in schema_migrations.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function main() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename));
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('applied', file);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('failed', file, err.message);
      process.exit(1);
    } finally {
      client.release();
    }
  }
  await pool.end();
}

main();
