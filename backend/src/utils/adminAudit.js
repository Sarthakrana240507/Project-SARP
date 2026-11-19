// Append-only record of administrator actions (a database trigger blocks UPDATE/DELETE).
// Never put secrets (tokens, passwords) in `details`.
async function logAdminAudit(db, { actorId, actorLabel = null, action, targetType = null, targetId = null, details = null }) {
  await db.query(
    `INSERT INTO admin_audit_log (actor_id, actor_label, action, target_type, target_id, details)
     VALUES ($1, COALESCE($2, (SELECT email FROM users WHERE id = $1)), $3, $4, $5, $6)`,
    [actorId, actorLabel, action, targetType, targetId === null ? null : String(targetId), details ? JSON.stringify(details) : null]
  );
}
module.exports = { logAdminAudit };
