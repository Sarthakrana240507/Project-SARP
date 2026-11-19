const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// Verifies the Bearer token, then loads the user from PostgreSQL on every request.
// The token only proves *who* the user is. Role and status always come from the database,
// so a suspended account or a changed role takes effect immediately, not at token expiry.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  let payload;
  try {
    payload = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
  }

  try {
    const result = await pool.query(
      // The revocation check is done by PostgreSQL, not JavaScript: password_changed_at is a
      // timezone-less TIMESTAMP written by NOW(), so comparing it in Node would silently depend
      // on the app server and database sharing a timezone.
      `SELECT id, role, status, is_super_admin,
              (password_changed_at IS NOT NULL
               AND date_trunc('second', password_changed_at) > to_timestamp($2)) AS issued_before_pw_change
       FROM users WHERE id = $1`,
      [payload.id, payload.iat]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Account no longer exists', code: 'TOKEN_INVALID' });

    // Tokens issued before the last password change are no longer valid.
    if (user.issued_before_pw_change) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.', code: 'TOKEN_INVALID' });
    }
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({
        error: user.status === 'SUSPENDED'
          ? 'This account has been suspended. Please contact the administrator.'
          : 'This account has not been activated yet.',
        code: user.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_NOT_ACTIVE',
      });
    }

    req.user = { id: user.id, role: user.role, isSuperAdmin: user.role === 'admin' && user.is_super_admin }; // from the database, not the token
    next();
  } catch (err) {
    console.error('Auth lookup failed:', err.message);
    res.status(500).json({ error: 'Authentication check failed' });
  }
}

// Use after requireAuth, e.g. requireRole('faculty', 'admin')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Only Super Admins may manage other administrators. Use after requireAuth.
function requireSuperAdmin(req, res, next) {
  if (!req.user || !req.user.isSuperAdmin) {
    return res.status(403).json({ error: 'Only a Super Admin can do this', code: 'SUPER_ADMIN_REQUIRED' });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireSuperAdmin };
