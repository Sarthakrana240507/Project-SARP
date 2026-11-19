// Tiny versioned migration runner.
// - Each migration is a file exporting { name, up(db) }, listed in order below.
// - Applied migrations are recorded in schema_migrations, so each runs exactly once.
// - Each migration runs inside its own transaction: it either fully applies or not at all.
// - An advisory lock stops two server instances from migrating at the same time.
const pool = require('../config/db');

const migrations = [require('./001_baseline'), require('./002_user_status'), require('./003_onboarding'), require('./004_faculty_scope'), require('./005_activity_lifecycle'), require('./006_academic_management'), require('./007_notifications'), require('./008_profile_photo'), require('./009_theme_preference'), require('./010_support_tickets')];

const LOCK_ID = 727274; // arbitrary constant for pg_advisory_lock

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const applied = [];
    for (const m of migrations) {
      if (done.has(m.name)) continue;
      try {
        await client.query('BEGIN');
        await m.up(client);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
        await client.query('COMMIT');
        applied.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed and was rolled back: ${err.message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { runMigrations, migrations };
