// One-time tokens for account activation and password reset.
// - 256 bits of randomness (crypto.randomBytes), URL-safe.
// - Only the SHA-256 hash is stored in PostgreSQL, so a database leak does not leak usable links.
// - Single use (used_at), expiring (expires_at), and issuing a new one revokes older unused ones.
// - The plaintext token exists only in the return value of issueToken(); it is never logged.
const crypto = require('crypto');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const TTL_MINUTES = () => ({
  ACTIVATION: Math.round(Number(process.env.INVITE_TTL_HOURS || 168) * 60),
  PASSWORD_RESET: Number(process.env.RESET_TTL_MINUTES || 60),
});

async function issueToken(db, { userId, purpose, delivery, createdBy = null }) {
  const minutes = TTL_MINUTES()[purpose];
  await db.query(
    `UPDATE auth_tokens SET revoked_at = NOW()
     WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [userId, purpose]
  );
  const token = crypto.randomBytes(32).toString('base64url');
  const r = await db.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, delivery, expires_at, created_by)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5), $6)
     RETURNING expires_at`,
    [userId, purpose, sha256(token), delivery, minutes, createdBy]
  );
  return { token, expires_at: r.rows[0].expires_at };
}

// Looks a token up by hash. Pass lock=true inside a transaction to serialise concurrent use.
// Every failure reason collapses into the same public message, so callers learn nothing
// about whether a token ever existed.
async function findUsableToken(db, token, purpose, { lock = false } = {}) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const r = await db.query(
    `SELECT t.id, t.user_id, t.purpose, t.delivery, t.expires_at,
            u.name, u.email, u.role, u.status, u.enrollment_no
     FROM auth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1
       AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > NOW()
       ${purpose ? 'AND t.purpose = $2' : ''}
     ${lock ? 'FOR UPDATE OF t' : ''}`,
    purpose ? [sha256(token), purpose] : [sha256(token)]
  );
  return r.rows[0] || null;
}

function buildLink(purpose, token) {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  // The token travels in the URL fragment (#), which browsers never send to servers,
  // so it does not appear in server logs or Referer headers.
  return `${base}/${purpose === 'ACTIVATION' ? 'activate' : 'reset-password'}#token=${token}`;
}

function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

module.exports = { issueToken, findUsableToken, buildLink, maskEmail, sha256 };
