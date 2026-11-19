// Helper for writing rows to the audit_log table.
// See logAudit() below for why the caller's transaction client must be passed in.
// Records a single status-change event on an activity. Called from the
// approve/reject routes so every verification decision is traceable:
// who reviewed it, what it changed from/to, and when.
//
// IMPORTANT: pass the same client used for the surrounding transaction
// (see routes/activities.js). audit_log has foreign keys into activities,
// so inserting on a *different* pooled connection while the activities row
// is still locked with FOR UPDATE in an open transaction will block forever
// waiting for a row lock that only the original transaction can release.
async function logAudit(runner, { activityId, studentId, reviewerId, oldStatus, newStatus, remarks, version = null }) {
  await runner.query(
    `INSERT INTO audit_log (activity_id, student_id, reviewer_id, old_status, new_status, remarks, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [activityId, studentId, reviewerId, oldStatus, newStatus, remarks || null, version]
  );
}

module.exports = { logAudit };
