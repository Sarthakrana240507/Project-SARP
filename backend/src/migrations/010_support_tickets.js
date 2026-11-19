// Migration 010 - support tickets. A new table only: nothing existing is changed.
// ticket_ref ("SUP-000123") is generated from the row id, so it is unique by construction.
// admin_notes are internal: no user-facing query selects that column.
module.exports = {
  name: '010_support_tickets',
  async up(db) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id          SERIAL PRIMARY KEY,
        ticket_ref  TEXT GENERATED ALWAYS AS ('SUP-' || lpad(id::text, 6, '0')) STORED UNIQUE,
        user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        name        TEXT NOT NULL,
        email       TEXT NOT NULL,
        category    TEXT NOT NULL,
        subject     TEXT NOT NULL,
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'OPEN',
        admin_notes TEXT,
        resolved_at TIMESTAMP,
        updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT support_tickets_status_chk CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED')),
        CONSTRAINT support_tickets_category_chk CHECK (category IN
          ('LOGIN','ACCOUNT','ACTIVITY_SUBMISSION','DOCUMENT_UPLOAD','VERIFICATION','TECHNICAL','OTHER'))
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets (user_id, created_at DESC, id DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status, created_at DESC)`);
  },
};
