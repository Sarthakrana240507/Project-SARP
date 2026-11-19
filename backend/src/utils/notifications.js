// In-app notifications (PostgreSQL). Straightforward on purpose: one row per recipient, read by polling.
//   createNotification(runner, {...})        one recipient
//   notifyAdmins(runner, {...})              every active admin
//   notifyScopedFaculty(runner, studentId, {...})  every active faculty whose scope covers the student
// `runner` is a transaction client or the pool. A notification must never break the action that caused it,
// so inside a transaction the insert runs in a savepoint and a failure is rolled back on its own.

const TYPES = ['info', 'success', 'warning', 'error'];

// Links must be in-app paths ("/activity/5"), never external addresses.
function safeLink(link) {
  if (typeof link !== 'string') return null;
  if (!link.startsWith('/') || link.startsWith('//') || link.includes('://') || link.length > 200) return null;
  return link;
}

async function createNotification(runner, { userId, title, message, type = 'info', link = null }) {
  if (!userId || !title || !message) return false;
  const inTx = typeof runner.release === 'function'; // a checked-out client is always inside our transaction
  try {
    if (inTx) await runner.query('SAVEPOINT notify_sp');
    await runner.query(
      `INSERT INTO notifications (user_id, title, message, type, link) VALUES ($1, $2, $3, $4, $5)`,
      [userId, String(title).slice(0, 150), String(message).slice(0, 1000), TYPES.includes(type) ? type : 'info', safeLink(link)]
    );
    if (inTx) await runner.query('RELEASE SAVEPOINT notify_sp');
    return true;
  } catch (err) {
    if (inTx) await runner.query('ROLLBACK TO SAVEPOINT notify_sp').catch(() => {});
    console.error('Failed to create in-app notification:', err.message);
    return false;
  }
}

async function notifyMany(runner, userIds, payload) {
  for (const userId of [...new Set(userIds)]) await createNotification(runner, { ...payload, userId });
}

async function notifyAdmins(runner, payload) {
  const r = await runner.query(`SELECT id FROM users WHERE role = 'admin' AND status = 'ACTIVE' AND is_active`);
  await notifyMany(runner, r.rows.map((x) => x.id), payload);
}

async function notifyScopedFaculty(runner, studentId, payload, alsoUserIds = []) {
  const r = await runner.query(
    `SELECT DISTINCT f.id FROM users s
       JOIN faculty_scopes fs ON fs.department IS NULL OR fs.department = s.department
       JOIN users f ON f.id = fs.faculty_id AND f.role = 'faculty' AND f.status = 'ACTIVE' AND f.is_active
      WHERE s.id = $1 AND s.role = 'student'`, [studentId]);
  await notifyMany(runner, [...r.rows.map((x) => x.id), ...alsoUserIds.filter(Boolean)], payload);
}

module.exports = { createNotification, notifyMany, notifyAdmins, notifyScopedFaculty, safeLink, TYPES };
