// Migration 007 - notifications: read timestamp, faster unread lookups, and basic safety rules.
// Additive only. Existing notifications are untouched.
module.exports = {
  name: '007_notifications',
  async up(db) {
    await db.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMP`);
    await db.query(`UPDATE notifications SET read_at = created_at WHERE is_read AND read_at IS NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC, id DESC)`);
    // NOT VALID: new rows must follow the rules; legacy rows are not rewritten or rejected.
    await db.query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_chk`);
    await db.query(`ALTER TABLE notifications ADD CONSTRAINT notifications_type_chk CHECK (type IN ('info','success','warning','error')) NOT VALID`);
    await db.query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_link_chk`);
    await db.query(`ALTER TABLE notifications ADD CONSTRAINT notifications_link_chk CHECK (link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%' AND link NOT LIKE '%://%')) NOT VALID`);
  },
};
