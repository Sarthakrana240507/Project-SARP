// Sends an activation invitation by email, but only when a mail service is really configured.
// Never claims success otherwise: the caller gets { sent: false } and falls back to hand-off links.
const { issueToken, buildLink } = require('./tokens');
const { emailEnabled, sendMail, activationEmail } = require('./mailer');

async function sendInvitation(db, userId, createdBy) {
  if (!emailEnabled()) return { sent: false, reason: 'EMAIL_NOT_CONFIGURED' };
  const u = (await db.query('SELECT name, email FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) return { sent: false, reason: 'NOT_FOUND' };
  const { token } = await issueToken(db, { userId, purpose: 'ACTIVATION', delivery: 'EMAIL', createdBy });
  const hours = Math.round(Number(process.env.INVITE_TTL_HOURS || 168));
  const mail = activationEmail({ name: u.name, link: buildLink('ACTIVATION', token), hours });
  const r = await sendMail({ to: u.email, ...mail });
  if (!r.sent) {
    // The link was never delivered, so it must not stay usable.
    await db.query(`UPDATE auth_tokens SET revoked_at = NOW() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId]);
    return { sent: false, reason: 'SEND_FAILED' };
  }
  return { sent: true };
}

module.exports = { sendInvitation };
