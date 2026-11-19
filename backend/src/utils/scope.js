// Verification scope: which students' records a user may see or decide on.
//   admin   -> every student
//   faculty -> students whose department is inside the faculty member's scope
//              (a scope row with department NULL means "all departments")
//   student -> only themselves
// One shared implementation so that no endpoint can forget the rule.

/** SQL for LIST queries. Appends the faculty's id to `params` and returns a fragment starting with " AND ...". */
function scopeFragment(user, params, studentDeptExpr = 'users.department') {
  if (user.role === 'admin') return '';
  if (user.role !== 'faculty') return ' AND FALSE';
  params.push(user.id);
  return ` AND EXISTS (SELECT 1 FROM faculty_scopes fs WHERE fs.faculty_id = $${params.length}
            AND (fs.department IS NULL OR fs.department = ${studentDeptExpr}))`;
}

/** Can `user` access this student's records? (single-record endpoints) */
async function canAccessStudent(db, user, studentId) {
  if (user.role === 'admin') return true;
  if (user.role === 'student') return user.id === studentId;
  if (user.role !== 'faculty') return false;
  const r = await db.query(
    `SELECT 1 FROM users s
     JOIN faculty_scopes fs ON fs.faculty_id = $1 AND (fs.department IS NULL OR fs.department = s.department)
     WHERE s.id = $2 AND s.role = 'student' LIMIT 1`,
    [user.id, studentId]
  );
  return r.rows.length > 0;
}

/** { all: boolean, departments: string[] } for display. */
async function getScope(db, facultyId) {
  const r = await db.query('SELECT department FROM faculty_scopes WHERE faculty_id = $1 ORDER BY department NULLS FIRST', [facultyId]);
  const all = r.rows.some((x) => x.department === null);
  return { all, departments: all ? [] : r.rows.map((x) => x.department) };
}

/** Replaces a faculty member's scope atomically (call inside a transaction). */
async function setScope(db, facultyId, { all, departments }, actorId) {
  await db.query('DELETE FROM faculty_scopes WHERE faculty_id = $1', [facultyId]);
  if (all) {
    await db.query('INSERT INTO faculty_scopes (faculty_id, department, created_by) VALUES ($1, NULL, $2)', [facultyId, actorId]);
    return;
  }
  for (const d of [...new Set(departments)]) {
    await db.query('INSERT INTO faculty_scopes (faculty_id, department, created_by) VALUES ($1, $2, $3)', [facultyId, d, actorId]);
  }
}

module.exports = { scopeFragment, canAccessStudent, getScope, setScope };
