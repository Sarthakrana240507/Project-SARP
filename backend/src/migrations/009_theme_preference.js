// Migration 009 - appearance preference stored on the account so it follows the user across devices.
// NULL means "never chosen on any device" (the browser's own setting then decides). Additive only.
module.exports = {
  name: '009_theme_preference',
  async up(db) {
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference TEXT`);
    await db.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_theme_preference_chk`);
    await db.query(`ALTER TABLE users ADD CONSTRAINT users_theme_preference_chk CHECK (theme_preference IN ('light','dark','system')) NOT VALID`);
  },
};
