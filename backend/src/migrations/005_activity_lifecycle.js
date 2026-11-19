// Migration 005 - activity lifecycle: activity date, submission versions, tamper-proof audit trail.
// Additive only. Constraints are added NOT VALID so old rows can never make this migration fail.
const STATUSES = ['draft', 'pending', 'resubmitted', 'approved', 'rejected', 'correction_requested'];

module.exports = {
  name: '005_activity_lifecycle',
  async up(db) {
    await db.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_date DATE`);
    // version = which submission of this activity is current (1 = first submission, 2 = first resubmission, ...)
    await db.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`);
    // id of the earlier submission that has the same proof file; shown to reviewers only
    await db.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS duplicate_of INTEGER`);

    // A draft may be saved before a category is chosen; every submitted activity must have one.
    await db.query(`ALTER TABLE activities ALTER COLUMN category DROP NOT NULL`);
    await db.query(`ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_category_required`);
    await db.query(`ALTER TABLE activities ADD CONSTRAINT activities_category_required CHECK (status = 'draft' OR category IS NOT NULL) NOT VALID`);
    await db.query(`ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_status_valid`);
    await db.query(`ALTER TABLE activities ADD CONSTRAINT activities_status_valid CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(',')})) NOT VALID`);

    // The categories table is the single source of truth. Make sure the built-in ones exist
    // (the old code accepted them from a hard-coded list even if an admin had deactivated them).
    const defaults = [
      ['hackathon', 'Hackathon & Competitions'], ['certification', 'Skill & Professional Certifications'],
      ['workshop', 'Technical Workshops & Bootcamps'], ['sports', 'Athletics & Sports Meets'],
      ['internship', 'Industry Internships & Training'], ['publication', 'Publications & Research'],
      ['volunteering', 'Volunteering & Community Service'],
    ];
    for (const [name, display] of defaults) {
      await db.query(`INSERT INTO categories (name, display_name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [name, display]);
    }

    // One row per submission. Old proof files are kept, so a resubmission never destroys earlier evidence.
    await db.query(`
      CREATE TABLE IF NOT EXISTS activity_versions (
        id SERIAL PRIMARY KEY,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        category TEXT,
        description TEXT,
        activity_date DATE,
        academic_session TEXT,
        semester TEXT,
        proof_file_path TEXT,
        proof_original_name TEXT,
        proof_mime_type TEXT,
        proof_size INTEGER,
        file_hash TEXT,
        is_duplicate BOOLEAN NOT NULL DEFAULT FALSE,
        duplicate_of INTEGER,
        note TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (activity_id, version)
      )`);
    await db.query(`
      INSERT INTO activity_versions (activity_id, version, title, category, description, academic_session, semester,
        proof_file_path, proof_original_name, proof_mime_type, proof_size, file_hash, is_duplicate, created_at)
      SELECT a.id, a.version, a.title, a.category, a.description, a.academic_session, a.semester,
        a.proof_file_path, a.proof_original_name, a.proof_mime_type, a.proof_size, a.file_hash, a.is_duplicate,
        COALESCE(a.resubmitted_at, a.created_at, NOW())
      FROM activities a
      WHERE a.status <> 'draft'
        AND NOT EXISTS (SELECT 1 FROM activity_versions v WHERE v.activity_id = a.id AND v.version = a.version)`);

    await db.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS version INTEGER`);

    // The verification history can be added to but never edited. Rows disappear only when the whole
    // activity (a draft the student discards, or a deleted account) is deleted.
    await db.query(`
      CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM activities WHERE id = OLD.activity_id) THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_log is append-only';
      END; $$ LANGUAGE plpgsql`);
    await db.query(`DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log`);
    await db.query(`
      CREATE TRIGGER audit_log_no_change
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()`);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_activities_student_created ON activities(student_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_activities_student_status ON activities(student_id, status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_activities_file_hash ON activities(file_hash) WHERE file_hash IS NOT NULL`);
  },
};
