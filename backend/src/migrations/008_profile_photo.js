// Migration 008 - profile photo: only a file reference is stored in PostgreSQL (the image lives in uploads/avatars).
// Additive only.
module.exports = {
  name: '008_profile_photo',
  async up(db) {
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_path TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_mime TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_updated_at TIMESTAMP`);
  },
};
