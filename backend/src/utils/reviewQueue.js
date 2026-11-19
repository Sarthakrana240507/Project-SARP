// Reviewer-side lists (the faculty "pending queue" and "review history") and the dashboard numbers.
// Every filter is applied by the database, and every query is limited to the reviewer's verification scope.
const pool = require('../config/db');
const { scopeFragment } = require('./scope');
const { likePattern, validCalendarDate } = require('./activityInput');
const { normalizeAcademicYear } = require('./validation');

class QueryError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// "Submitted on" is when the CURRENT version was sent for review (not when a draft was first created).
const SUBMITTED_AT = `(SELECT MAX(v.created_at) FROM activity_versions v WHERE v.activity_id = activities.id)`;

const QUEUE_SORTS = {
  oldest: `${SUBMITTED_AT} ASC, activities.id ASC`, // longest-waiting first: the fair default for a queue
  newest: `${SUBMITTED_AT} DESC, activities.id DESC`,
};
const HISTORY_SORTS = {
  reviewed_newest: 'activities.reviewed_at DESC, activities.id DESC',
  reviewed_oldest: 'activities.reviewed_at ASC, activities.id ASC',
  ...QUEUE_SORTS,
};
const HISTORY_STATUSES = ['approved', 'rejected', 'correction_requested'];
const QUEUE_STATUSES = ['pending', 'resubmitted'];

/**
 * mode 'queue'   -> activities waiting for a decision (pending + resubmitted)
 * mode 'history' -> activities that already have a decision (approved / rejected / correction_requested)
 * Drafts never appear in either: they are private to the student.
 */
async function listForReviewer(user, q, mode) {
  const isQueue = mode === 'queue';
  const params = [];
  const where = [isQueue
    ? `activities.status IN ('pending', 'resubmitted')`
    : `activities.status IN ('approved', 'rejected', 'correction_requested')`];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

  const statuses = isQueue ? QUEUE_STATUSES : HISTORY_STATUSES;
  if (q.status && q.status !== 'all') {
    if (!statuses.includes(q.status)) throw new QueryError('Unknown status filter');
    add('activities.status = ?', q.status);
  }
  if (q.department && q.department !== 'all') add('users.department = ?', String(q.department));
  if (q.category && q.category !== 'all') add('activities.category = ?', String(q.category).toLowerCase());
  if (q.academic_session && q.academic_session !== 'all') {
    const y = normalizeAcademicYear(q.academic_session);
    if (!y) throw new QueryError('Academic year must look like 2025-2026');
    add('activities.academic_session = ?', y);
  }
  if (q.semester && q.semester !== 'all') {
    if (!/^\d{1,2}$/.test(String(q.semester))) throw new QueryError('Semester must be a number');
    add('activities.semester = ?', String(Number(q.semester)));
  }
  for (const [key, op] of [['date_from', '>='], ['date_to', '<=']]) {
    if (!q[key]) continue;
    if (!validCalendarDate(String(q[key]))) throw new QueryError(`${key} must be a date like 2026-01-31`);
    add(`${SUBMITTED_AT}::date ${op} ?::date`, String(q[key]));
  }
  if (q.date_from && q.date_to && String(q.date_from) > String(q.date_to)) throw new QueryError('The start date is after the end date');
  if (q.duplicate === 'true') where.push('activities.is_duplicate = TRUE');
  if (!isQueue && q.reviewed_by === 'me') add('activities.reviewer_id = ?', user.id);
  if (q.search && String(q.search).trim()) {
    params.push(likePattern(q.search));
    const p = `$${params.length}`;
    where.push(`(activities.title ILIKE ${p} OR users.name ILIKE ${p} OR users.email ILIKE ${p} OR COALESCE(users.enrollment_no, '') ILIKE ${p})`);
  }
  const sorts = isQueue ? QUEUE_SORTS : HISTORY_SORTS;
  const sortKey = q.sort || (isQueue ? 'oldest' : 'reviewed_newest');
  if (!sorts[sortKey]) throw new QueryError('Unknown sort order');

  const limit = Math.min(50, Math.max(1, parseInt(q.limit, 10) || 10));
  const page = Math.max(1, parseInt(q.page, 10) || 1);

  // scopeFragment appends its own parameter, so it must come after everything else has been added.
  const scoped = where.join(' AND ') + scopeFragment(user, params);
  const from = `FROM activities JOIN users ON users.id = activities.student_id WHERE ${scoped}`;

  const [total, rows] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n ${from}`, params),
    pool.query(
      `SELECT activities.*, users.name AS student_name, users.email AS student_email, users.department,
              users.enrollment_no AS student_enrollment_no,
              ${SUBMITTED_AT} AS submitted_at,
              (SELECT name FROM users r WHERE r.id = activities.reviewer_id) AS reviewer_name
       ${from} ORDER BY ${sorts[sortKey]} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
  ]);
  return { rows: rows.rows, total: total.rows[0].n, page, limit, pages: Math.max(1, Math.ceil(total.rows[0].n / limit)) };
}

/** Numbers for the faculty dashboard, limited to this reviewer's scope. */
async function reviewSummary(user) {
  const params = [];
  const scope = scopeFragment(user, params);
  const recentParams = [...params]; // the "recent" query has no use for the reviewer-id parameter added below
  params.push(user.id);
  const me = `$${params.length}`;
  const base = `FROM activities JOIN users ON users.id = activities.student_id WHERE activities.status <> 'draft'${scope}`;
  const counts = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE activities.status IN ('pending','resubmitted'))::int AS pending,
            COUNT(*) FILTER (WHERE activities.status = 'resubmitted')::int AS resubmitted,
            COUNT(*) FILTER (WHERE activities.status = 'approved')::int AS approved,
            COUNT(*) FILTER (WHERE activities.status = 'rejected')::int AS rejected,
            COUNT(*) FILTER (WHERE activities.status = 'correction_requested')::int AS correction_requested,
            COUNT(*) FILTER (WHERE activities.status IN ('pending','resubmitted') AND activities.is_duplicate)::int AS duplicate_warnings,
            COUNT(*) FILTER (WHERE activities.reviewer_id = ${me}
                             AND activities.status IN ('approved','rejected','correction_requested'))::int AS reviewed_by_me
     ${base}`, params);
  const recent = await pool.query(
    `SELECT activities.id, activities.title, activities.status, activities.reviewed_at, activities.version,
            users.name AS student_name, users.department,
            (SELECT name FROM users r WHERE r.id = activities.reviewer_id) AS reviewer_name
     ${base} AND activities.status IN ('approved','rejected','correction_requested') AND activities.reviewed_at IS NOT NULL
     ORDER BY activities.reviewed_at DESC, activities.id DESC LIMIT 5`, recentParams);
  // Departments this reviewer can filter by (students inside their scope), so the filter never offers an empty choice.
  const dp = [];
  const depts = await pool.query(
    `SELECT DISTINCT users.department FROM users WHERE users.role = 'student' AND users.department IS NOT NULL${scopeFragment(user, dp)} ORDER BY 1`, dp);
  return { ...counts.rows[0], recently_reviewed: recent.rows, departments: depts.rows.map((r) => r.department) };
}

module.exports = { listForReviewer, reviewSummary, QueryError };
