// Migration 004 - faculty provisioning, verification scope, Super Admin.
// Additive only. Existing faculty keep the access they have today (see backfill below).
module.exports = {
  name: '004_faculty_scope',
  async up(db) {
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS designation TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE`);

    // Only administrators can be Super Admins (enforced by the database, not just the app).
    await db.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_super_admin_is_admin`);
    await db.query(`ALTER TABLE users ADD CONSTRAINT users_super_admin_is_admin CHECK (NOT is_super_admin OR role = 'admin')`);

    // Unique faculty/employee IDs (case-insensitive); skip with a warning if legacy data conflicts.
    const dup = await db.query(`
      SELECT UPPER(employee_id) FROM users WHERE employee_id IS NOT NULL AND employee_id <> ''
      GROUP BY UPPER(employee_id) HAVING COUNT(*) > 1 LIMIT 1`);
    if (dup.rows.length) {
      console.warn('[migration 004] Duplicate employee IDs exist; skipped unique index. Resolve manually.');
    } else {
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id_uq ON users (UPPER(employee_id)) WHERE employee_id IS NOT NULL AND employee_id <> ''`);
    }

    // Verification scope: which students' records a faculty member may review.
    // department = NULL means "all departments". No rows at all means NO access (secure default).
    await db.query(`
      CREATE TABLE IF NOT EXISTS faculty_scopes (
        id SERIAL PRIMARY KEY,
        faculty_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        department TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS faculty_scopes_uq ON faculty_scopes (faculty_id, COALESCE(department, '*'))`);

    // Backfill: faculty that already exist could review every department before this change.
    // Grant them "all departments" so nothing breaks; an administrator can narrow it afterwards.
    await db.query(`
      INSERT INTO faculty_scopes (faculty_id, department)
      SELECT u.id, NULL FROM users u
      WHERE u.role = 'faculty' AND NOT EXISTS (SELECT 1 FROM faculty_scopes s WHERE s.faculty_id = u.id)`);
  },
};
