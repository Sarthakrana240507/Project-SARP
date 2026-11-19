const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { JWT_EXPIRES_IN } = require('../config/env');
const { issueToken: issueOneTimeToken, findUsableToken, buildLink, maskEmail } = require('../utils/tokens');
const { emailEnabled, sendMail, activationEmail, resetEmail } = require('../utils/mailer');
const { passwordProblem, normName } = require('../utils/validation');
const { createNotification, notifyAdmins } = require('../utils/notifications');
const { getScope } = require('../utils/scope');

const router = express.Router();

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    department: row.department,
    enrollment_no: row.enrollment_no || null,
    academic_year: row.academic_year || null,
    semester: row.semester || null,
    status: row.status,
    is_active: row.status === 'ACTIVE',
    employee_id: row.employee_id || null,
    designation: row.designation || null,
    programme: row.programme || null,
    is_super_admin: row.role === 'admin' && row.is_super_admin === true,
    // Never the file path: only whether a photo exists and a version number so browsers refresh it after a change.
    has_photo: Boolean(row.profile_image_path),
    photo_version: row.profile_image_updated_at ? new Date(row.profile_image_updated_at).getTime() : null,
    theme_preference: row.theme_preference || null,
    created_at: row.created_at,
  };
}

const USER_COLUMNS = `id, name, email, role, department, enrollment_no, academic_year, semester, status, employee_id, designation, programme, is_super_admin, profile_image_path, profile_image_updated_at, theme_preference, created_at`;

// Brute-force protection: limit per IP+email (credential guessing) and per IP (spraying).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `${req.ip}|${String(req.body?.email || '').trim().toLowerCase()}`,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
});
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many sign-in attempts from this network. Please try again later.',
});
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `pw|${req.user?.id || req.ip}`,
  message: 'Too many password change attempts. Please try again later.',
});

// Compared against when the email is unknown, so response time does not reveal
// whether an account exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

function issueToken(user) {
  // The role is informational only: the server always re-reads it from the database.
  return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  });
}

/**
 * POST /auth/register - CLOSED.
 * Open self-registration was removed: anyone could create a student account.
 * Accounts are created from the administrator's student roster; students activate
 * them with POST /auth/request-activation or the invitation link.
 */
router.post('/register', (_req, res) => {
  res.status(410).json({
    error: 'Open registration is closed. Activate the account your college created for you, or contact your administrator.',
    code: 'REGISTRATION_CLOSED',
  });
});

const PORTALS = { student: 'Student Portal', faculty: 'Faculty Portal', admin: 'Administrator Access' };
router.post('/login', loginIpLimiter, loginLimiter, async (req, res) => {
  try {
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const rawPortal = req.body.portal;
    const portal = rawPortal === undefined || rawPortal === null || rawPortal === '' ? null : rawPortal;
    if (portal !== null && (typeof portal !== 'string' || !Object.prototype.hasOwnProperty.call(PORTALS, portal))) return res.status(400).json({ error: 'portal must be student, faculty or admin' });
    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    const row = result.rows[0];

    const hashToCheck = row?.password_hash || DUMMY_HASH;
    const passwordOk = await bcrypt.compare(password, hashToCheck);
    if (!row || !row.password_hash || !passwordOk) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Status is only revealed after the password is verified.
    if (row.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'This account has been suspended. Please contact the administrator.', code: 'ACCOUNT_SUSPENDED' });
    }
    if (row.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'This account has not been activated yet.', code: 'ACCOUNT_NOT_ACTIVE' });
    }
    // The sign-in screen the person used (optional). It never grants anything: the role always comes from the database.
    // A mismatch is refused here, after the password was verified, with no token issued and no login recorded.
    if (portal && row.role !== portal) {
      return res.status(403).json({ error: `These credentials are not for the ${PORTALS[portal]}. Please choose the right sign-in option.`, code: 'PORTAL_MISMATCH' });
    }
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [row.id]);
    const user = publicUser(row);
    res.json({ user, token: issueToken(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });
    const user = publicUser(row);
    if (row.role === 'faculty') user.verification_scope = await getScope(pool, row.id);
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch current user' });
  }
});

/**
 * PUT /auth/profile
 * Users may edit only their own display name here.
 * Role, email, student ID, department, academic year/semester and status are
 * administrator-controlled: an attempt to change them is rejected, not ignored.
 */
const RESTRICTED_FIELDS = ['role', 'email', 'department', 'enrollment_no', 'academic_year', 'semester', 'status', 'is_active', 'employee_id', 'designation', 'programme', 'is_super_admin'];
const norm = (v) => (v === null || v === undefined ? '' : String(v).trim());

router.put('/profile', requireAuth, async (req, res) => {
  try {
    const current = (await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.user.id])).rows[0];
    if (!current) return res.status(404).json({ error: 'User not found' });

    const currentView = { ...current, is_active: current.status === 'ACTIVE' };
    const attempted = RESTRICTED_FIELDS.filter(
      (f) => req.body[f] !== undefined && norm(req.body[f]) !== norm(currentView[f])
    );
    if (attempted.length) {
      return res.status(403).json({
        error: 'These fields can only be changed by an administrator: ' + attempted.join(', '),
      });
    }

    const name = req.body.name === undefined ? current.name : String(req.body.name).replace(/\s+/g, ' ').trim();
    if (!name) return res.status(400).json({ error: 'Full name cannot be empty' });
    if (name.length < 2) return res.status(400).json({ error: 'Full name must be at least 2 characters long' });
    if (name.length > 100) return res.status(400).json({ error: 'Full name must be 100 characters or fewer' });
    // Names end up in exported CSV/PDF files, so the same spreadsheet-formula rule as the student import applies.
    if (/^[=+\-@\t]/.test(name)) return res.status(400).json({ error: 'Full name must not start with = + - or @' });

    const result = await pool.query(
      `UPDATE users SET name = $1 WHERE id = $2 RETURNING ${USER_COLUMNS}`,
      [name, req.user.id]
    );
    res.json({ user: publicUser(result.rows[0]), message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * PUT /auth/preferences  { theme: 'light' | 'dark' | 'system' }
 * Remembers the appearance choice on the account so it follows the user to other devices.
 * It is a display preference only, so any signed-in user may change their own.
 */
const THEMES = ['light', 'dark', 'system'];
router.put('/preferences', requireAuth, async (req, res) => {
  try {
    const theme = req.body?.theme;
    if (!THEMES.includes(theme)) return res.status(400).json({ error: 'theme must be light, dark or system' });
    await pool.query('UPDATE users SET theme_preference = $1 WHERE id = $2', [theme, req.user.id]);
    res.json({ theme_preference: theme });
  } catch (err) {
    console.error('Preferences error:', err.message);
    res.status(500).json({ error: 'Could not save the preference' });
  }
});

/**
 * PUT /auth/change-password
 * Accepts current_password/new_password (API style) or currentPassword/newPassword.
 * On success all older tokens stop working and a fresh token is returned for this session.
 */
router.put('/change-password', requireAuth, passwordLimiter, async (req, res) => {
  try {
    const currentPassword = req.body.current_password ?? req.body.currentPassword;
    const newPassword = req.body.new_password ?? req.body.newPassword;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });

    const userRes = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const row = userRes.rows[0];
    if (!row || !(await bcrypt.compare(String(currentPassword), row.password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (String(currentPassword) === String(newPassword)) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }

    const newHash = await bcrypt.hash(String(newPassword), 12);
    const updated = await pool.query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2 RETURNING ${USER_COLUMNS}`,
      [newHash, req.user.id]
    );
    res.json({ success: true, message: 'Password updated successfully', token: issueToken(updated.rows[0]) });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});


// ---------------------------------------------------------------------------
// Account activation, roster-verified registration and password reset
// ---------------------------------------------------------------------------
const INVALID_LINK = { error: 'This link is invalid or has expired. Ask your administrator for a new one.', code: 'TOKEN_INVALID_OR_EXPIRED' };

const tokenLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many attempts. Please try again later.' });
const activateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Please try again later.' });
const requestIpLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many requests. Please try again later.' });
const requestIdLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  keyFn: (req) => `act|${String(req.body?.student_id || '').trim().toUpperCase()}`,
  message: 'Too many requests for this student ID. Please try again later.',
});
const forgotIpLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many requests. Please try again later.' });
const forgotEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 3,
  keyFn: (req) => `fp|${String(req.body?.email || '').trim().toLowerCase()}`,
  message: 'Too many requests for this email. Please try again later.',
});

/** GET /auth/config - public, non-sensitive capability flags used to tailor UI messages. */
router.get('/config', (_req, res) => {
  res.json({ email_delivery: emailEnabled() });
});

/** POST /auth/token-info - lets the activation/reset page show who the link is for. */
router.post('/token-info', tokenLimiter, async (req, res) => {
  try {
    const t = await findUsableToken(pool, req.body.token, null);
    if (!t || (t.purpose === 'ACTIVATION' && t.status !== 'INVITED') || (t.purpose === 'PASSWORD_RESET' && t.status !== 'ACTIVE')) {
      return res.status(400).json(INVALID_LINK);
    }
    res.json({ purpose: t.purpose, name: t.name, email: maskEmail(t.email), expires_at: t.expires_at });
  } catch (err) {
    console.error('token-info error:', err.message);
    res.status(500).json({ error: 'Could not check this link' });
  }
});

/** POST /auth/activate - verifies the invitation token, sets the password, activates the account. */
router.post('/activate', activateLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await findUsableToken(client, req.body.token, 'ACTIVATION', { lock: true });
    if (!t || t.status !== 'INVITED') {
      await client.query('ROLLBACK');
      return res.status(400).json(INVALID_LINK);
    }
    const problem = passwordProblem(req.body.password, { email: t.email, studentId: t.enrollment_no });
    if (problem) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: problem });
    }
    const hash = await bcrypt.hash(String(req.body.password), 12);
    await client.query(
      `UPDATE users
       SET password_hash = $1, status = 'ACTIVE', is_active = TRUE, activated_at = NOW(),
           email_verified_at = CASE WHEN $3 = 'EMAIL' THEN NOW() ELSE email_verified_at END
       WHERE id = $2`,
      [hash, t.user_id, t.delivery]
    );
    await client.query('UPDATE auth_tokens SET used_at = NOW() WHERE id = $1', [t.id]);
    await client.query(
      `UPDATE auth_tokens SET revoked_at = NOW() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [t.user_id]
    );
    await createNotification(client, {
      userId: t.user_id,
      title: 'Account Activated',
      message: 'Your SARP account is active. Welcome aboard.',
      type: 'success',
      link: '/profile',
    });
    await client.query('COMMIT');
    res.json({ success: true, message: 'Your account is active. You can now sign in.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Activation error:', err.message);
    res.status(500).json({ error: 'Activation failed. Please try again.' });
  } finally {
    client.release();
  }
});

/**
 * POST /auth/request-activation  (Method B: verified self-registration)
 * The student proves they are on the approved roster by giving Student ID + official
 * email + name, all of which must match the administrator-imported record. A matching
 * email domain alone is never enough. The activation link is NEVER returned here:
 * it is emailed (when SMTP is configured) or handed over by the administrator.
 */
router.post('/request-activation', requestIpLimiter, requestIdLimiter, async (req, res) => {
  try {
    const studentId = String(req.body.student_id || '').trim().toUpperCase();
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    if (!studentId || !email || !name) {
      return res.status(400).json({ error: 'Student ID, official email and full name are all required' });
    }
    const NOT_FOUND = {
      error: 'We could not find a matching student record. Check your details or contact your college administrator.',
      code: 'RECORD_NOT_FOUND',
    };

    const r = await pool.query(
      `SELECT id, name, email, status FROM users
       WHERE role = 'student' AND UPPER(enrollment_no) = $1 AND LOWER(email) = $2`,
      [studentId, email]
    );
    const row = r.rows[0];
    if (!row || normName(row.name) !== normName(name)) return res.status(404).json(NOT_FOUND);

    if (row.status === 'ACTIVE') {
      return res.status(409).json({ error: 'This account is already active. Sign in, or use "Forgot password".', code: 'ALREADY_ACTIVE' });
    }
    if (row.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'This account is suspended. Please contact your administrator.', code: 'ACCOUNT_SUSPENDED' });
    }

    if (emailEnabled()) {
      const { token } = await issueOneTimeToken(pool, { userId: row.id, purpose: 'ACTIVATION', delivery: 'EMAIL' });
      const mail = activationEmail({
        name: row.name, link: buildLink('ACTIVATION', token),
        hours: Math.round(Number(process.env.INVITE_TTL_HOURS || 168)),
      });
      const result = await sendMail({ to: row.email, ...mail });
      if (!result.sent) {
        await pool.query(`UPDATE auth_tokens SET revoked_at = NOW() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [row.id]);
        return res.status(502).json({ error: 'We could not send the email. Please contact your administrator.', code: 'EMAIL_FAILED' });
      }
      return res.status(202).json({ delivery: 'EMAIL', message: 'An activation link has been sent to your official email address.' });
    }

    // No mail service: record the request and tell the administrators.
    await notifyAdmins(pool, {
      title: 'Activation Requested',
      message: `${row.name} (${studentId}) asked for an activation link. Email delivery is not configured, so please generate one.`,
      type: 'info',
      link: '/admin',
    });
    res.status(202).json({
      delivery: 'ADMIN',
      message: 'Your request has been recorded. Email delivery is not set up, so your administrator will give you your activation link.',
    });
  } catch (err) {
    console.error('request-activation error:', err.message);
    res.status(500).json({ error: 'Could not process the request' });
  }
});

/** POST /auth/forgot-password - never reveals whether an account exists. */
router.post('/forgot-password', forgotIpLimiter, forgotEmailLimiter, async (req, res) => {
  try {
    if (!emailEnabled()) {
      return res.json({
        delivery: 'ADMIN',
        message: 'Email delivery is not set up on this system. Please contact your administrator to reset your password.',
      });
    }
    const email = String(req.body.email || '').trim().toLowerCase();
    const r = await pool.query(`SELECT id, name, email FROM users WHERE LOWER(email) = $1 AND status = 'ACTIVE'`, [email]);
    if (r.rows[0]) {
      const u = r.rows[0];
      const { token } = await issueOneTimeToken(pool, { userId: u.id, purpose: 'PASSWORD_RESET', delivery: 'EMAIL' });
      const mail = resetEmail({ name: u.name, link: buildLink('PASSWORD_RESET', token), minutes: Number(process.env.RESET_TTL_MINUTES || 60) });
      await sendMail({ to: u.email, ...mail });
    }
    res.json({ delivery: 'EMAIL', message: 'If that address belongs to an active account, a reset link has been sent.' });
  } catch (err) {
    console.error('forgot-password error:', err.message);
    res.status(500).json({ error: 'Could not process the request' });
  }
});

/** POST /auth/reset-password - consumes a reset token and revokes all existing sessions. */
router.post('/reset-password', activateLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await findUsableToken(client, req.body.token, 'PASSWORD_RESET', { lock: true });
    if (!t || t.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json(INVALID_LINK);
    }
    const problem = passwordProblem(req.body.password, { email: t.email, studentId: t.enrollment_no });
    if (problem) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: problem });
    }
    const hash = await bcrypt.hash(String(req.body.password), 12);
    await client.query('UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2', [hash, t.user_id]);
    await client.query('UPDATE auth_tokens SET used_at = NOW() WHERE id = $1', [t.id]);
    await client.query(`UPDATE auth_tokens SET revoked_at = NOW() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [t.user_id]);
    await createNotification(client, {
      userId: t.user_id, title: 'Password Changed',
      message: 'Your password was reset. If this was not you, contact your administrator immediately.', type: 'warning',
    });
    await client.query('COMMIT');
    res.json({ success: true, message: 'Password updated. You can now sign in.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Reset error:', err.message);
    res.status(500).json({ error: 'Password reset failed. Please try again.' });
  } finally {
    client.release();
  }
});

module.exports = router;
