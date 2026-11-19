// Academic management for administrators: departments, programmes, academic years (sessions), activity categories,
// student/faculty academic assignment, and the administrator audit log viewer.
//
// Rules that apply to everything here:
//  - Nothing is ever deleted. Old records keep pointing at departments / programmes / categories / years, so
//    "removing" something means deactivating (or closing) it. Historical records stay readable.
//  - Every change is written to admin_audit_log in the same transaction as the change itself.
//  - Names that other records refer to by text (a department name on a student, a category on an activity) are either
//    immutable (category identifier) or renamed everywhere inside one transaction (department, programme).
const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAdminAudit } = require('../utils/adminAudit');
const { normalizeAcademicYear, programmeKey } = require('../utils/validation');
const { likePattern, validCalendarDate } = require('../utils/activityInput');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

class HttpError extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const fail = (status, error, extra = {}) => new HttpError(status, { error, ...extra });
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    if (err.code === '23505') return res.status(409).json({ error: 'That value already exists.' }); // unique violation (race)
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const squash = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const CONTROL = /[\u0000-\u001F\u007F]/;
const need = (cond, msg) => { if (!cond) throw fail(400, msg); };
const actor = (req) => ({ actorId: req.user.id, actorLabel: req.user.email });
const boolean = (v, field) => { if (typeof v !== 'boolean') throw fail(400, `${field} must be true or false`); return v; };

function cleanName(v, label, max = 100) {
  const s = squash(v);
  need(s.length >= 2 && s.length <= max, `${label} must be 2-${max} characters.`);
  need(!CONTROL.test(s) && !/[<>]/.test(s), `${label} contains unsupported characters.`);
  return s;
}
function cleanCode(v, label, max) {
  const s = squash(v).toUpperCase();
  need(/^[A-Z0-9]+$/.test(s) && s.length >= 2 && s.length <= max, `${label} must be 2-${max} letters or digits.`);
  return s;
}
const semesterNumber = (v) => {
  const m = /^\s*(?:semester\s*)?(\d{1,2})\s*$/i.exec(String(v ?? ''));
  const n = m ? Number(m[1]) : NaN;
  need(n >= 1 && n <= 12, 'Semester must be a number from 1 to 12.');
  return n;
};

// ================================================================== departments
router.get('/departments', handle(async (_req, res) => {
  const r = await pool.query(`
    SELECT d.*,
           (SELECT COUNT(*)::int FROM users u WHERE u.department = d.name AND u.role = 'student') AS student_count,
           (SELECT COUNT(*)::int FROM users u WHERE u.department = d.name AND u.role = 'faculty') AS faculty_count,
           (SELECT COUNT(*)::int FROM faculty_scopes f WHERE f.department = d.name) AS scope_count
    FROM departments d ORDER BY d.code`);
  res.json(r.rows);
}));

router.post('/departments', handle(async (req, res) => {
  const code = cleanCode(req.body.code, 'Department code', 10);
  const name = cleanName(req.body.name, 'Department name');
  const row = await inTransaction(async (db) => {
    const clash = await db.query('SELECT code, name FROM departments WHERE UPPER(code) = $1 OR LOWER(name) = LOWER($2)', [code, name]);
    if (clash.rows.length) throw fail(409, 'A department with this code or name already exists.');
    const r = await db.query('INSERT INTO departments (code, name, is_active) VALUES ($1, $2, TRUE) RETURNING *', [code, name]);
    await logAdminAudit(db, { ...actor(req), action: 'DEPARTMENT_CREATED', targetType: 'department', targetId: r.rows[0].id, details: { code, name } });
    return r.rows[0];
  });
  res.status(201).json(row);
}));

router.put('/departments/:id', handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid department id');
  const row = await inTransaction(async (db) => {
    const cur = (await db.query('SELECT * FROM departments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw fail(404, 'Department not found');
    const code = req.body.code === undefined ? cur.code : cleanCode(req.body.code, 'Department code', 10);
    const name = req.body.name === undefined ? cur.name : cleanName(req.body.name, 'Department name');
    if (code === cur.code && name === cur.name) throw fail(400, 'Nothing to change.');
    const clash = await db.query('SELECT 1 FROM departments WHERE id <> $1 AND (UPPER(code) = $2 OR LOWER(name) = LOWER($3))', [id, code, name]);
    if (clash.rows.length) throw fail(409, 'Another department already uses this code or name.');
    const moved = { students_and_staff: 0, scopes: 0 };
    if (name !== cur.name) {
      // Users and verification scopes refer to a department by name, so the new name is applied to all of them together.
      moved.students_and_staff = (await db.query('UPDATE users SET department = $1 WHERE department = $2', [name, cur.name])).rowCount;
      moved.scopes = (await db.query('UPDATE faculty_scopes SET department = $1 WHERE department = $2', [name, cur.name])).rowCount;
    }
    const r = await db.query('UPDATE departments SET code = $1, name = $2 WHERE id = $3 RETURNING *', [code, name, id]);
    await logAdminAudit(db, { ...actor(req), action: 'DEPARTMENT_UPDATED', targetType: 'department', targetId: id,
      details: { from: { code: cur.code, name: cur.name }, to: { code, name }, updated: moved } });
    return r.rows[0];
  });
  res.json(row);
}));

router.patch('/departments/:id/status', handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid department id');
  const active = boolean(req.body.is_active, 'is_active');
  const row = await inTransaction(async (db) => {
    const cur = (await db.query('SELECT * FROM departments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw fail(404, 'Department not found');
    if (cur.is_active === active) return cur;
    const r = await db.query('UPDATE departments SET is_active = $1 WHERE id = $2 RETURNING *', [active, id]);
    await logAdminAudit(db, { ...actor(req), action: active ? 'DEPARTMENT_ACTIVATED' : 'DEPARTMENT_DEACTIVATED', targetType: 'department', targetId: id, details: { code: cur.code, name: cur.name } });
    return r.rows[0];
  });
  res.json(row);
}));

// ================================================================== programmes
router.get('/programmes', handle(async (_req, res) => {
  const r = await pool.query(`
    SELECT p.*, (SELECT COUNT(*)::int FROM users u WHERE u.role = 'student' AND u.programme = p.name) AS student_count
    FROM programmes p ORDER BY p.is_active DESC, p.name`);
  res.json(r.rows);
}));

const programmeClash = async (db, code, name, exceptId = 0) => {
  const all = await db.query('SELECT id, code, name FROM programmes WHERE id <> $1', [exceptId]);
  return all.rows.some((p) => p.code.toUpperCase() === code || programmeKey(p.name) === programmeKey(name));
};
function cleanProgrammeName(v) {
  const s = squash(v);
  need(s.length >= 2 && s.length <= 50 && /^[A-Za-z0-9][A-Za-z0-9 .&()/-]*$/.test(s), 'Programme name must be 2-50 characters (letters, digits, spaces and . & ( ) / -).');
  return s;
}

router.post('/programmes', handle(async (req, res) => {
  const name = cleanProgrammeName(req.body.name);
  const code = cleanCode(req.body.code, 'Programme code', 20);
  const row = await inTransaction(async (db) => {
    if (await programmeClash(db, code, name)) throw fail(409, 'A programme with this code or name already exists.');
    const r = await db.query('INSERT INTO programmes (code, name) VALUES ($1, $2) RETURNING *', [code, name]);
    await logAdminAudit(db, { ...actor(req), action: 'PROGRAMME_CREATED', targetType: 'programme', targetId: r.rows[0].id, details: { code, name } });
    return r.rows[0];
  });
  res.status(201).json(row);
}));

router.put('/programmes/:id', handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid programme id');
  const row = await inTransaction(async (db) => {
    const cur = (await db.query('SELECT * FROM programmes WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw fail(404, 'Programme not found');
    const name = req.body.name === undefined ? cur.name : cleanProgrammeName(req.body.name);
    const code = req.body.code === undefined ? cur.code : cleanCode(req.body.code, 'Programme code', 20);
    if (name === cur.name && code === cur.code) throw fail(400, 'Nothing to change.');
    if (await programmeClash(db, code, name, id)) throw fail(409, 'Another programme already uses this code or name.');
    const updated = name !== cur.name ? (await db.query('UPDATE users SET programme = $1 WHERE programme = $2', [name, cur.name])).rowCount : 0;
    const r = await db.query('UPDATE programmes SET code = $1, name = $2 WHERE id = $3 RETURNING *', [code, name, id]);
    await logAdminAudit(db, { ...actor(req), action: 'PROGRAMME_UPDATED', targetType: 'programme', targetId: id,
      details: { from: { code: cur.code, name: cur.name }, to: { code, name }, students_updated: updated } });
    return r.rows[0];
  });
  res.json(row);
}));

router.patch('/programmes/:id/status', handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid programme id');
  const active = boolean(req.body.is_active, 'is_active');
  const row = await inTransaction(async (db) => {
    const cur = (await db.query('SELECT * FROM programmes WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw fail(404, 'Programme not found');
    if (cur.is_active === active) return cur;
    const r = await db.query('UPDATE programmes SET is_active = $1 WHERE id = $2 RETURNING *', [active, id]);
    await logAdminAudit(db, { ...actor(req), action: active ? 'PROGRAMME_ACTIVATED' : 'PROGRAMME_DEACTIVATED', targetType: 'programme', targetId: id, details: { code: cur.code, name: cur.name } });
    return r.rows[0];
  });
  res.json(row);
}));

// ================================================================== academic years (sessions) and semesters
// current_semester is stored as plain digits ("5"); older rows may say "Semester 5" and are still understood.
const sessionOut = (r) => ({ ...r, current_semester_number: (/(\d+)/.exec(String(r.current_semester)) || [])[1] ? Number(/(\d+)/.exec(String(r.current_semester))[1]) : null });

router.get('/sessions', handle(async (_req, res) => {
  const r = await pool.query(`
    SELECT s.*, (SELECT COUNT(*)::int FROM activities a WHERE a.status <> 'draft' AND a.academic_session = s.name) AS activity_count
    FROM academic_sessions s ORDER BY s.is_current DESC, s.name DESC`);
  res.json(r.rows.map(sessionOut));
}));

router.post('/sessions', handle(async (req, res) => {
  const name = normalizeAcademicYear(req.body.name);
  need(name, 'Academic year must look like 2025-2026 (two consecutive years).');
  const semester = String(semesterNumber(req.body.current_semester));
  const makeCurrent = req.body.is_current === undefined ? false : boolean(req.body.is_current, 'is_current');
  const row = await inTransaction(async (db) => {
    if ((await db.query('SELECT 1 FROM academic_sessions WHERE name = $1', [name])).rows.length) throw fail(409, 'This academic year already exists. Edit it instead.');
    if (makeCurrent) await db.query('UPDATE academic_sessions SET is_current = FALSE WHERE is_current');
    const r = await db.query('INSERT INTO academic_sessions (name, current_semester, is_current) VALUES ($1, $2, $3) RETURNING *', [name, semester, makeCurrent]);
    await logAdminAudit(db, { ...actor(req), action: 'SESSION_CREATED', targetType: 'academic_session', targetId: r.rows[0].id, details: { name, current_semester: semester, is_current: makeCurrent } });
    return r.rows[0];
  });
  res.status(201).json(sessionOut(row));
}));

router.put('/sessions/:id', handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid session id');
  const semester = String(semesterNumber(req.body.current_semester));
  const row = await inTransaction(async (db) => {
    const cur = (await db.query('SELECT * FROM academic_sessions WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw fail(404, 'Academic year not found');
    const r = await db.query('UPDATE academic_sessions SET current_semester = $1 WHERE id = $2 RETURNING *', [semester, id]);
    await logAdminAudit(db, { ...actor(req), action: 'SESSION_UPDATED', targetType: 'academic_session', targetId: id, details: { name: cur.name, from: cur.current_semester, to: semester } });
    return r.rows[0];
  });
  res.json(sessionOut(row));
}));

router.patch('/sessions/:id/set-current', handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid session id');
  const row = await inTransaction(async (db) => {
    const cur = (await db.query('SELECT * FROM academic_sessions WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw fail(404, 'Academic year not found');
    if (cur.is_archived) throw fail(409, 'A closed academic year cannot be the current one. Reopen it first.');
    await db.query('UPDATE academic_sessions SET is_current = FALSE WHERE is_current AND id <> $1', [id]);
    const r = await db.query('UPDATE academic_sessions SET is_current = TRUE WHERE id = $1 RETURNING *', [id]);
    if (!cur.is_current) await logAdminAudit(db, { ...actor(req), action: 'SESSION_SET_CURRENT', targetType: 'academic_session', targetId: id, details: { name: cur.name } });
    return r.rows[0];
  });
  res.json(sessionOut(row));
}));

/** PATCH /admin/sessions/:id/archive { archived: true|false } - closes (or reopens) a year for NEW submissions. Records stay. */
router.patch('/sessions/:id/archive', handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid session id');
  const archived = boolean(req.body.archived, 'archived');
  const row = await inTransaction(async (db) => {
    const cur = (await db.query('SELECT * FROM academic_sessions WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw fail(404, 'Academic year not found');
    if (archived && cur.is_current) throw fail(409, 'The current academic year cannot be closed. Make another year current first.');
    if (cur.is_archived === archived) return cur;
    const r = await db.query('UPDATE academic_sessions SET is_archived = $1 WHERE id = $2 RETURNING *', [archived, id]);
    await logAdminAudit(db, { ...actor(req), action: archived ? 'SESSION_CLOSED' : 'SESSION_REOPENED', targetType: 'academic_session', targetId: id, details: { name: cur.name } });
    return r.rows[0];
  });
  res.json(sessionOut(row));
}));

// ================================================================== activity categories
router.get('/categories', handle(async (_req, res) => {
  const r = await pool.query(`
    SELECT c.*, (SELECT COUNT(*)::int FROM activities a WHERE a.category = c.name) AS usage_count
    FROM categories c ORDER BY c.is_active DESC, c.display_name`);
  res.json(r.rows);
}));

router.post('/categories', handle(async (req, res) => {
  const name = squash(req.body.name).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  need(/^[a-z0-9][a-z0-9_-]{1,39}$/.test(name), 'Category identifier must be 2-40 characters: lower-case letters, digits, _ or -.');
  const display = cleanName(req.body.display_name, 'Display name', 60);
  const row = await inTransaction(async (db) => {
    const clash = await db.query('SELECT 1 FROM categories WHERE name = $1 OR LOWER(display_name) = LOWER($2)', [name, display]);
    if (clash.rows.length) throw fail(409, 'A category with this identifier or display name already exists.');
    const r = await db.query('INSERT INTO categories (name, display_name, is_active) VALUES ($1, $2, TRUE) RETURNING *', [name, display]);
    await logAdminAudit(db, { ...actor(req), action: 'CATEGORY_CREATED', targetType: 'category', targetId: r.rows[0].id, details: { name, display_name: display } });
    return r.rows[0];
  });
  res.status(201).json(row);
}));

// Only the display name can change: the identifier is what existing activities are stored under.
router.put('/categories/:id', handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid category id');
  const display = cleanName(req.body.display_name, 'Display name', 60);
  const row = await inTransaction(async (db) => {
    const cur = (await db.query('SELECT * FROM categories WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw fail(404, 'Category not found');
    if (cur.display_name === display) throw fail(400, 'Nothing to change.');
    if ((await db.query('SELECT 1 FROM categories WHERE id <> $1 AND LOWER(display_name) = LOWER($2)', [id, display])).rows.length) throw fail(409, 'Another category already uses this display name.');
    const r = await db.query('UPDATE categories SET display_name = $1 WHERE id = $2 RETURNING *', [display, id]);
    await logAdminAudit(db, { ...actor(req), action: 'CATEGORY_UPDATED', targetType: 'category', targetId: id, details: { name: cur.name, from: cur.display_name, to: display } });
    return r.rows[0];
  });
  res.json(row);
}));

router.patch('/categories/:id/status', handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid category id');
  const active = boolean(req.body.is_active, 'is_active');
  const row = await inTransaction(async (db) => {
    const cur = (await db.query('SELECT * FROM categories WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw fail(404, 'Category not found');
    if (cur.is_active === active) return cur;
    if (!active) {
      // Students could not submit anything if every category were switched off.
      const others = (await db.query('SELECT COUNT(*)::int n FROM categories WHERE is_active AND id <> $1', [id])).rows[0].n;
      if (others === 0) throw fail(409, 'At least one category must stay active.');
    }
    const r = await db.query('UPDATE categories SET is_active = $1 WHERE id = $2 RETURNING *', [active, id]);
    await logAdminAudit(db, { ...actor(req), action: active ? 'CATEGORY_ACTIVATED' : 'CATEGORY_DEACTIVATED', targetType: 'category', targetId: id, details: { name: cur.name } });
    return r.rows[0];
  });
  res.json(row);
}));

// ================================================================== academic assignment of a user
/**
 * PATCH /admin/users/:id/academic
 *   student: { department?, programme?, academic_year?, semester? }
 *   faculty: { department? }  (which students they may VERIFY is separate: see the verification scope)
 * Only active departments / programmes can be assigned. Before and after values go to the audit log.
 */
router.patch('/users/:id/academic', handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid user id');
  const body = req.body || {};
  const row = await inTransaction(async (db) => {
    const u = (await db.query('SELECT id, role, department, programme, academic_year, semester FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!u) throw fail(404, 'User not found');
    if (!['student', 'faculty'].includes(u.role)) throw fail(400, 'Only students and faculty have an academic assignment.');
    const allowed = u.role === 'student' ? ['department', 'programme', 'academic_year', 'semester'] : ['department'];
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length) throw fail(400, `Cannot change: ${unknown.join(', ')}`);
    const next = {};

    if (body.department !== undefined) {
      const key = squash(body.department).toLowerCase();
      const d = (await db.query('SELECT name, is_active FROM departments WHERE LOWER(code) = $1 OR LOWER(name) = $1', [key])).rows[0];
      if (!d) throw fail(400, 'That department does not exist.');
      if (!d.is_active) throw fail(400, 'That department is inactive.');
      next.department = d.name;
    }
    if (body.programme !== undefined) {
      const key = programmeKey(body.programme);
      const all = (await db.query('SELECT name, code, is_active FROM programmes')).rows;
      const p = all.find((x) => programmeKey(x.name) === key || programmeKey(x.code) === key);
      if (!p) throw fail(400, 'That programme does not exist.');
      if (!p.is_active) throw fail(400, 'That programme is inactive.');
      next.programme = p.name;
    }
    if (body.academic_year !== undefined) {
      const y = normalizeAcademicYear(body.academic_year);
      if (!y) throw fail(400, 'Academic year must look like 2025-2026.');
      next.academic_year = y;
    }
    if (body.semester !== undefined) next.semester = String(semesterNumber(body.semester));

    const changed = Object.keys(next).filter((k) => String(next[k]) !== String(u[k] ?? ''));
    if (!changed.length) throw fail(400, 'Nothing to change.');
    const sets = changed.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const r = await db.query(`UPDATE users SET ${sets} WHERE id = $1
      RETURNING id, name, email, role, department, programme, academic_year, semester`, [id, ...changed.map((k) => next[k])]);
    await logAdminAudit(db, { ...actor(req), action: changed.includes('department') ? 'DEPARTMENT_ASSIGNED' : 'ACADEMIC_ASSIGNMENT_CHANGED', targetType: 'user', targetId: id,
      details: { role: u.role, from: Object.fromEntries(changed.map((k) => [k, u[k] ?? null])), to: Object.fromEntries(changed.map((k) => [k, next[k]])) } });
    return r.rows[0];
  });
  res.json(row);
}));

// ================================================================== administrator audit log
/**
 * GET /admin/audit?action=&search=&target_type=&date_from=&date_to=&page=&limit=
 * Read-only: a database trigger stops anyone from editing or deleting these rows.
 */
router.get('/audit', handle(async (req, res) => {
  const q = req.query;
  const where = []; const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.action && q.action !== 'all') add('l.action = ?', String(q.action));
  if (q.target_type && q.target_type !== 'all') add('l.target_type = ?', String(q.target_type));
  for (const [key, op] of [['date_from', '>='], ['date_to', '<=']]) {
    if (!q[key]) continue;
    if (!validCalendarDate(String(q[key]))) throw fail(400, `${key} must be a date like 2026-01-31`);
    add(`l.created_at::date ${op} ?::date`, String(q[key]));
  }
  if (q.date_from && q.date_to && String(q.date_from) > String(q.date_to)) throw fail(400, 'The start date is after the end date');
  if (q.search && String(q.search).trim()) {
    params.push(likePattern(q.search));
    const p = `$${params.length}`;
    where.push(`(COALESCE(u.name, '') ILIKE ${p} OR COALESCE(l.actor_label, '') ILIKE ${p} OR l.action ILIKE ${p} OR COALESCE(l.target_id, '') ILIKE ${p} OR COALESCE(l.details::text, '') ILIKE ${p})`);
  }
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM admin_audit_log l LEFT JOIN users u ON u.id = l.actor_id ${whereSql}`;
  const [total, rows, actions] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int n ${from}`, params),
    pool.query(`SELECT l.id, l.action, l.target_type, l.target_id, l.details, l.created_at, l.actor_id,
                       COALESCE(u.name, l.actor_label) AS actor_name, l.actor_label
                ${from} ORDER BY l.created_at DESC, l.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
    pool.query('SELECT DISTINCT action FROM admin_audit_log ORDER BY action'),
  ]);
  res.json({ entries: rows.rows, total: total.rows[0].n, page, limit, pages: Math.max(1, Math.ceil(total.rows[0].n / limit)), actions: actions.rows.map((r) => r.action) });
}));

module.exports = router;
