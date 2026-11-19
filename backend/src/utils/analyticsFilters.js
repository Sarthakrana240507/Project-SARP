// Filters shared by the analytics view, CSV and PDF exports, so all three always describe the same rows.
// Every value is validated here; anything unexpected is a 400, never a database error.
const { scopeFragment } = require('./scope');
const { normalizeAcademicYear } = require('./validation');

// semester is stored as text; older rows may read "Semester 5". Compare and group on the number.
const SEM = `NULLIF(regexp_replace(activities.semester, '[^0-9]', '', 'g'), '')::int`;

const STATUSES = ['pending', 'approved', 'rejected', 'correction_requested', 'resubmitted'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const one = (v) => (Array.isArray(v) ? v[0] : v);
const isAll = (v) => v === undefined || v === null || v === '' || v === 'all';

/** -> { filters } with only the active filters, or { error }. */
function parseFilters(query = {}) {
  const f = {};
  const text = (key, max = 100) => {
    const v = one(query[key]);
    if (isAll(v)) return null;
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) return `Invalid ${key.replace('_', ' ')} filter`;
    f[key] = v.trim();
    return null;
  };
  for (const key of ['department', 'programme']) { const e = text(key); if (e) return { error: e }; }
  const cat = one(query.category);
  if (!isAll(cat)) {
    if (typeof cat !== 'string' || !/^[a-z0-9_ -]{1,50}$/i.test(cat)) return { error: 'Invalid category filter' };
    f.category = cat.toLowerCase();
  }
  const status = one(query.status);
  if (!isAll(status)) {
    if (!STATUSES.includes(status)) return { error: 'Invalid status filter' };
    f.status = status;
  }
  const session = one(query.academic_session);
  if (!isAll(session)) {
    const year = normalizeAcademicYear(String(session));
    if (!year) return { error: 'Academic year must look like 2025-2026' };
    f.academic_session = year;
  }
  const sem = one(query.semester);
  if (!isAll(sem)) {
    if (!/^\d{1,2}$/.test(String(sem)) || Number(sem) < 1 || Number(sem) > 12) return { error: 'Semester must be a number from 1 to 12' };
    f.semester = Number(sem);
  }
  for (const key of ['date_from', 'date_to']) {
    const v = one(query[key]);
    if (isAll(v)) continue;
    if (!validDate(String(v))) return { error: `${key === 'date_from' ? 'Start' : 'End'} date must be a real date (YYYY-MM-DD)` };
    f[key] = String(v);
  }
  if (f.date_from && f.date_to && f.date_from > f.date_to) return { error: 'The start date must not be after the end date' };
  return { filters: f };
}

/** WHERE clause (+ params) for `activities JOIN users ON users.id = activities.student_id`. */
function buildWhere(filters, user) {
  const params = []; const c = [];
  const scoped = scopeFragment(user, params, 'users.department');
  if (scoped) c.push(scoped.replace(/^ AND /, ''));
  c.push(`activities.status <> 'draft'`); // a draft is private: never part of a statistic or export
  const add = (sql, v) => { params.push(v); c.push(sql.replace('?', `$${params.length}`)); };
  if (filters.department) add('users.department = ?', filters.department);
  if (filters.programme) add('users.programme = ?', filters.programme);
  if (filters.category) add('activities.category = ?', filters.category);
  if (filters.status === 'pending') c.push(`activities.status IN ('pending', 'resubmitted')`);
  else if (filters.status) add('activities.status = ?', filters.status);
  if (filters.academic_session) add('activities.academic_session = ?', filters.academic_session);
  if (filters.semester) add(`${SEM} = ?`, filters.semester);
  if (filters.date_from) add('activities.created_at >= ?::date', filters.date_from);
  if (filters.date_to) add(`activities.created_at < (?::date + INTERVAL '1 day')`, filters.date_to);
  return { where: `WHERE ${c.join(' AND ')}`, params };
}

const LABELS = { department: 'Department', programme: 'Programme', category: 'Category', status: 'Status', academic_session: 'Academic year', semester: 'Semester', date_from: 'Submitted from', date_to: 'Submitted to' };
/** Human-readable list of the active filters, for the PDF. */
const describe = (filters) => Object.entries(filters).map(([k, v]) => `${LABELS[k]}: ${k === 'status' ? String(v).replace(/_/g, ' ') : v}`);

module.exports = { parseFilters, buildWhere, describe, STATUSES, SEM };
