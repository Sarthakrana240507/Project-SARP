// Migration 003 - student onboarding: INVITED accounts, one-time tokens, CSV import history,
// administrator audit log. Additive only; no existing data is modified or removed.
module.exports = {
  name: '003_onboarding',
  async up(db) {
    // INVITED accounts have no password yet.
    await db.query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS programme TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMP`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS import_batch_id INTEGER`);

    // Integrity rule: an ACTIVE account must always have a password.
    await db.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_active_has_password`);
    await db.query(`ALTER TABLE users ADD CONSTRAINT users_active_has_password CHECK (status <> 'ACTIVE' OR password_hash IS NOT NULL)`);

    // Unique student IDs (case-insensitive). Legacy data may already contain duplicates;
    // never fail startup or delete anything: skip the index and warn instead.
    const dup = await db.query(`
      SELECT UPPER(enrollment_no) FROM users WHERE enrollment_no IS NOT NULL AND enrollment_no <> ''
      GROUP BY UPPER(enrollment_no) HAVING COUNT(*) > 1 LIMIT 1`);
    if (dup.rows.length) {
      console.warn('[migration 003] Duplicate student IDs exist; skipped unique student-ID index. Resolve manually.');
    } else {
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_student_id_uq ON users (UPPER(enrollment_no)) WHERE enrollment_no IS NOT NULL AND enrollment_no <> ''`);
    }

    // One-time tokens for activation and password reset. Only the SHA-256 hash is stored.
    await db.query(`
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('ACTIVATION','PASSWORD_RESET')),
        token_hash TEXT NOT NULL UNIQUE,
        delivery TEXT NOT NULL CHECK (delivery IN ('EMAIL','ADMIN_HANDOFF')),
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        revoked_at TIMESTAMP,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose)`);

    // CSV import history. 'payload' holds the validated rows between preview and confirm.
    await db.query(`
      CREATE TABLE IF NOT EXISTS import_batches (
        id SERIAL PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'STUDENT',
        filename TEXT,
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','COMMITTED','CANCELLED')),
        total_rows INTEGER NOT NULL DEFAULT 0,
        valid_rows INTEGER NOT NULL DEFAULT 0,
        error_rows INTEGER NOT NULL DEFAULT 0,
        imported_count INTEGER,
        failed_count INTEGER,
        invites_sent INTEGER NOT NULL DEFAULT 0,
        invites_failed INTEGER NOT NULL DEFAULT 0,
        payload JSONB,
        errors JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        committed_at TIMESTAMP
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_import_batches_created ON import_batches(created_at DESC)`);

    // Administrator audit log (append-only: a trigger blocks UPDATE and DELETE).
    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        actor_id INTEGER,          -- deliberately no foreign key: the audit trail must outlive the account
        actor_label TEXT,          -- snapshot of the actor's email at the time of the action
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        details JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`);
    await db.query(`
      CREATE OR REPLACE FUNCTION admin_audit_log_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'admin_audit_log is append-only';
      END; $$ LANGUAGE plpgsql`);
    await db.query(`DROP TRIGGER IF EXISTS admin_audit_log_no_change ON admin_audit_log`);
    await db.query(`
      CREATE TRIGGER admin_audit_log_no_change
      BEFORE UPDATE OR DELETE ON admin_audit_log
      FOR EACH ROW EXECUTE FUNCTION admin_audit_log_immutable()`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC)`);
  },
};
