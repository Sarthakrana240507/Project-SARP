// Creates the first Super Admin from the server's terminal. No password is chosen or printed:
// the script prints a one-time activation link (valid for INVITE_TTL_HOURS) that the owner opens to set their own.
//
//   npm run admin:create -- --email you@example.com --name "Your Name"
//   Options: --promote  turn an existing ADMIN account into a Super Admin
//            --force    allow creating another Super Admin when one already exists
require('dotenv').config();
const pool = require('../src/config/db');
const { initSchema } = require('../src/models/schema');
const { issueToken, buildLink } = require('../src/utils/tokens');
const { logAdminAudit } = require('../src/utils/adminAudit');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--promote' || a === '--force') out[a.slice(2)] = true;
    else if (a === '--email' || a === '--name') out[a.slice(2)] = argv[++i];
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || '').trim().toLowerCase();
  const name = String(args.name || '').trim();
  let exitCode = 0;
  try {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Provide a valid --email');
    await initSchema();

    const existingSuper = (await pool.query(`SELECT 1 FROM users WHERE role = 'admin' AND is_super_admin LIMIT 1`)).rows.length > 0;
    if (existingSuper && !args.force) {
      throw new Error('A Super Admin already exists. Sign in as that account and use the Administrators tab, or re-run with --force.');
    }

    const found = (await pool.query('SELECT id, role, status FROM users WHERE LOWER(email) = $1', [email])).rows[0];
    let userId;
    if (found) {
      if (found.role !== 'admin') throw new Error('That email belongs to a non-admin account. Refusing to change it.');
      if (!args.promote) throw new Error('That administrator already exists. Use --promote to make it a Super Admin.');
      await pool.query('UPDATE users SET is_super_admin = TRUE WHERE id = $1', [found.id]);
      userId = found.id;
      console.log(`Promoted ${email} to Super Admin.`);
      if (found.status !== 'INVITED') {
        await logAdminAudit(pool, { actorId: null, actorLabel: 'cli:create-admin', action: 'SUPER_ADMIN_GRANTED', targetType: 'user', targetId: userId });
        return;
      }
    } else {
      if (name.length < 2) throw new Error('Provide --name (at least 2 characters)');
      const r = await pool.query(
        `INSERT INTO users (name, email, role, status, is_active, is_super_admin, invited_at)
         VALUES ($1, $2, 'admin', 'INVITED', FALSE, TRUE, NOW()) RETURNING id`, [name, email]);
      userId = r.rows[0].id;
      console.log(`Created Super Admin account for ${email} (not active until the link below is used).`);
    }

    const { token, expires_at } = await issueToken(pool, { userId, purpose: 'ACTIVATION', delivery: 'ADMIN_HANDOFF', createdBy: null });
    await logAdminAudit(pool, {
      actorId: null, actorLabel: 'cli:create-admin', action: 'SUPER_ADMIN_CREATED', targetType: 'user', targetId: userId,
    });
    console.log('\nOne-time activation link (shown only now, single use):');
    console.log(buildLink('ACTIVATION', token));
    console.log(`Expires: ${new Date(expires_at).toISOString()}\n`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    exitCode = 1;
  } finally {
    await pool.end();
    process.exitCode = exitCode;
  }
})();
