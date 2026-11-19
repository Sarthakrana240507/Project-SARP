// Migration 002 - explicit account status + password-change tracking.
// Additive only: nothing is dropped, existing rows are back-filled from is_active.
module.exports = {
  name: '002_user_status',
  async up(db) {
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT`);
    // Back-fill: deactivated accounts become SUSPENDED, everyone else ACTIVE.
    await db.query(`UPDATE users SET status = CASE WHEN is_active = FALSE THEN 'SUSPENDED' ELSE 'ACTIVE' END WHERE status IS NULL OR status NOT IN ('INVITED', 'ACTIVE', 'SUSPENDED')`);
    await db.query(`ALTER TABLE users ALTER COLUMN status SET DEFAULT 'ACTIVE'`);
    await db.query(`ALTER TABLE users ALTER COLUMN status SET NOT NULL`);
    await db.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check`);
    await db.query(`ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('INVITED','ACTIVE','SUSPENDED'))`);

    // Tokens issued before this moment are rejected (set on password change).
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP`);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)`);

    // Case-insensitive email uniqueness. The app already lowercases emails, but the
    // old UNIQUE(email) constraint is case-sensitive. If legacy data already contains
    // case-variant duplicates we must not fail startup or delete anything: skip and warn.
    const dup = await db.query(`SELECT LOWER(email) AS e FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1 LIMIT 1`);
    if (dup.rows.length) {
      console.warn('[migration 002] Case-variant duplicate emails exist; skipped unique LOWER(email) index. Resolve manually.');
    } else {
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users (LOWER(email))`);
    }
  },
};
