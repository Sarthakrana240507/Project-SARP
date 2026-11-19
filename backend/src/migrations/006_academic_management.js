// Migration 006 - academic management: programmes, closing (archiving) academic years.
// Additive only. Nothing is deleted or rewritten, so history is preserved.
module.exports = {
  name: '006_academic_management',
  async up(db) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS programmes (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS programmes_code_uq ON programmes (UPPER(code))`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS programmes_name_uq ON programmes (LOWER(name))`);

    // Starting list: the usual degrees plus whatever students already have, so no existing record is orphaned.
    const defaults = ['BTech', 'MTech', 'MBA', 'MCA', 'BCA', 'BSc', 'MSc'];
    const existing = (await db.query(`SELECT DISTINCT programme FROM users WHERE programme IS NOT NULL AND programme <> ''`)).rows.map((r) => r.programme);
    for (const name of [...new Set([...defaults, ...existing])]) {
      const code = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || 'PRG';
      await db.query(`INSERT INTO programmes (code, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [code, name]);
    }

    // An academic year can be closed for new submissions without losing any of its records.
    await db.query(`ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE`);

    // At most one "current" academic year (enforced by the database). Skipped with a warning if legacy data has several.
    const cur = (await db.query(`SELECT COUNT(*)::int n FROM academic_sessions WHERE is_current`)).rows[0].n;
    if (cur > 1) console.warn('[migration 006] More than one current academic year exists; skipped unique index. Fix manually.');
    else await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS academic_sessions_one_current ON academic_sessions ((is_current)) WHERE is_current`);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action)`);
  },
};
