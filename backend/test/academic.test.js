// Phase 7 tests: departments, programmes, academic years, categories, academic assignment, admin audit log.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');
const app = require('../src/server');
const { initSchema } = require('../src/models/schema');
const { rateLimit } = require('../src/middleware/rateLimit');
const { setScope } = require('../src/utils/scope');
const { transitionProblem, TRANSITIONS, STATUSES } = require('../src/utils/lifecycle');
const { validCalendarDate, likePattern } = require('../src/utils/activityInput');

const PASSWORD = 'TestPass@12345';
const P = `p7${Date.now()}`;
const UPLOADS = path.resolve(__dirname, '../uploads');
let server; let base; let adminToken; let seq = 0;
const pathsToClean = new Set();
const created = { dept: [], prog: [], sess: [], cat: [] };

// ------------------------------------------------------------------ helpers
async function send(p, { method = 'GET', token, fields, file, json } = {}) {
  const init = { method, headers: token ? { Authorization: `Bearer ${token}` } : {} };
  if (json) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
  else if (fields || file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields || {})) if (v !== undefined) fd.append(k, v);
    if (file) fd.append('proof', new Blob([file.buf], { type: file.type }), file.name);
    init.body = fd;
  }
  const res = await fetch(base + p, init);
  const buf = Buffer.from(await res.arrayBuffer());
  let data = {}; try { data = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, data, buf, headers: res.headers };
}
const rnd = () => crypto.randomBytes(24);
const pdf = () => ({ buf: Buffer.concat([Buffer.from('%PDF-1.4\n%'), rnd(), Buffer.from('\n%%EOF')]), name: 'certificate.pdf', type: 'application/pdf' });
const png = () => ({ buf: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), rnd()]), name: 'badge.png', type: 'image/png' });
const jpg = () => ({ buf: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), rnd()]), name: 'photo.jpg', type: 'image/jpeg' });
const webp = () => ({ buf: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBP'), rnd()]), name: 'pic.webp', type: 'image/webp' });
const good = (over = {}) => ({ title: 'Smart India Hackathon Finalist', category: 'hackathon', description: 'Built a working prototype', activity_date: '2026-01-15', academic_session: '2025-2026', semester: '5', ...over });

async function makeUser({ role, department = 'Computer Science & Engineering', scope }) {
  const n = `${P}x${++seq}`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const email = `${n}@college.test`;
  const id = (await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active,department,employee_id,enrollment_no)
     VALUES ($1,$2,$3,$4,'ACTIVE',TRUE,$5,$6,$7) RETURNING id`,
    [`User ${n}`, email, hash, role, department, role === 'faculty' ? n.toUpperCase() : null, role === 'student' ? n.toUpperCase() : null])).rows[0].id;
  if (role === 'faculty') await setScope(pool, id, scope || { all: true, departments: [] }, null);
  const token = (await send('/auth/login', { method: 'POST', json: { email, password: PASSWORD } })).data.token;
  return { id, email, token };
}
const settle = () => new Promise((r) => setTimeout(r, 150)); // lets the async file clean-up finish
const uploadFiles = () => new Set(fs.readdirSync(UPLOADS));
async function newFilesDuring(fn) {
  const before = uploadFiles();
  const result = await fn();
  await settle();
  return { result, leftovers: [...uploadFiles()].filter((f) => !before.has(f)) };
}
const filePathOf = async (id) => (await pool.query('SELECT proof_file_path FROM activities WHERE id = $1', [id])).rows[0]?.proof_file_path;
async function submit(student, over = {}, file = pdf()) {
  const r = await send('/activities', { method: 'POST', token: student.token, fields: good(over), file });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  pathsToClean.add(await filePathOf(r.data.id));
  return r.data;
}
async function reviewer(over = {}) { return makeUser({ role: 'faculty', ...over }); }

test.before(async () => {
  await initSchema();
  await new Promise((r) => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  adminToken = (await makeUser({ role: 'admin' })).token;
});
test.beforeEach(() => rateLimit.resetAll());
test.after(async () => {
  const ids = (await pool.query(`SELECT id FROM users WHERE email LIKE $1`, [`${P}%`])).rows.map((r) => r.id);
  const files = (await pool.query(`SELECT proof_file_path p FROM activities WHERE student_id = ANY($1) UNION SELECT proof_file_path FROM activity_versions WHERE activity_id IN (SELECT id FROM activities WHERE student_id = ANY($1))`, [ids])).rows.map((r) => r.p);
  for (const f of [...files, ...pathsToClean]) if (f) fs.rmSync(f, { force: true });
  await pool.query(`UPDATE categories SET is_active = TRUE WHERE name = 'workshop'`);
  await pool.query('DELETE FROM activities WHERE student_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  // everything this file created (the lists are filled in by the tests below)
  await pool.query('DELETE FROM academic_sessions WHERE id = ANY($1)', [created.sess]);
  await pool.query('DELETE FROM programmes WHERE id = ANY($1)', [created.prog]);
  await pool.query('DELETE FROM departments WHERE id = ANY($1)', [created.dept]);
  await pool.query('DELETE FROM categories WHERE id = ANY($1)', [created.cat]);
  await new Promise((r) => server.close(r));
  await pool.end();
});


const adm = (p, o = {}) => send(p, { ...o, token: adminToken });
const auditFor = async (action, targetId) => (await pool.query('SELECT * FROM admin_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id DESC', [action, String(targetId)])).rows;
const code = (n) => `${P}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-6) + n;

test('only administrators can reach academic management', async () => {
  const f = await makeUser({ role: 'faculty' }); const s = await makeUser({ role: 'student' });
  for (const t of [f, s]) for (const url of ['/admin/departments', '/admin/programmes', '/admin/sessions', '/admin/categories', '/admin/audit']) {
    assert.strictEqual((await send(url, { token: t.token })).status, 403, url);
  }
  assert.strictEqual((await send('/admin/departments')).status, 401);
  // The academic router must protect itself, not rely on the routers mounted before it.
  const express = require('express');
  const solo = express(); solo.use(express.json()); solo.use('/admin', require('../src/routes/adminAcademic'));
  const soloServer = await new Promise((r) => { const sv = http.createServer(solo).listen(0, () => r(sv)); });
  try {
    for (const url of ['/admin/departments', '/admin/audit']) {
      const res = await fetch(`http://127.0.0.1:${soloServer.address().port}${url}`, { headers: { Authorization: `Bearer ${s.token}` } });
      assert.strictEqual(res.status, 403, `${url} on its own`);
    }
  } finally { await new Promise((r) => soloServer.close(r)); }
  assert.strictEqual((await send('/admin/departments', { method: 'POST', token: s.token, json: { code: 'XX', name: 'Nope' } })).status, 403);
});

test('departments: validation, no silent overwrite, rename keeps every reference, deactivate instead of delete', async () => {
  const c = code(1);
  for (const bad of [{}, { code: 'A', name: 'Short code' }, { code: 'ok1', name: '' }, { code: 'ok 2!', name: 'Bad code' }, { code: 'OK3', name: '<script>' }]) {
    assert.strictEqual((await adm('/admin/departments', { method: 'POST', json: bad })).status, 400, JSON.stringify(bad));
  }
  const made = await adm('/admin/departments', { method: 'POST', json: { code: c.toLowerCase(), name: `  Dept ${P}   Alpha ` } });
  assert.strictEqual(made.status, 201);
  assert.strictEqual(made.data.code, c, 'code upper-cased');
  assert.strictEqual(made.data.name, `Dept ${P} Alpha`, 'name tidied');
  created.dept.push(made.data.id);
  assert.strictEqual((await adm('/admin/departments', { method: 'POST', json: { code: c, name: 'Different name' } })).status, 409, 'same code');
  assert.strictEqual((await adm('/admin/departments', { method: 'POST', json: { code: code(9), name: `dept ${P} alpha` } })).status, 409, 'same name, other case');
  assert.strictEqual((await adm('/admin/departments')).data.find((d) => d.id === made.data.id).name, `Dept ${P} Alpha`, 'the failed POSTs changed nothing');
  assert.strictEqual((await auditFor('DEPARTMENT_CREATED', made.data.id)).length, 1);

  // rename: students, faculty and verification scopes all follow
  const stu = await makeUser({ role: 'student', department: made.data.name });
  const fac = await makeUser({ role: 'faculty', scope: { all: false, departments: [made.data.name] } });
  const ren = await adm(`/admin/departments/${made.data.id}`, { method: 'PUT', json: { name: `Dept ${P} Beta` } });
  assert.strictEqual(ren.status, 200);
  assert.strictEqual((await pool.query('SELECT department FROM users WHERE id=$1', [stu.id])).rows[0].department, `Dept ${P} Beta`);
  assert.deepStrictEqual((await pool.query('SELECT department FROM faculty_scopes WHERE faculty_id=$1', [fac.id])).rows.map((r) => r.department), [`Dept ${P} Beta`]);
  const a = (await auditFor('DEPARTMENT_UPDATED', made.data.id))[0];
  assert.deepStrictEqual([a.details.from.name, a.details.to.name, a.details.updated.students_and_staff, a.details.updated.scopes], [`Dept ${P} Alpha`, `Dept ${P} Beta`, 1, 1]);
  assert.strictEqual((await adm(`/admin/departments/${made.data.id}`, { method: 'PUT', json: { name: `Dept ${P} Beta` } })).status, 400, 'no-op is refused');
  const other = await adm('/admin/departments', { method: 'POST', json: { code: code(2), name: `Dept ${P} Gamma` } }); created.dept.push(other.data.id);
  assert.strictEqual((await adm(`/admin/departments/${other.data.id}`, { method: 'PUT', json: { name: `Dept ${P} Beta` } })).status, 409, 'cannot rename onto an existing name');
  assert.strictEqual((await adm('/admin/departments/999999999', { method: 'PUT', json: { name: 'Nothing Here' } })).status, 404);

  // deactivate keeps the records and blocks new assignment
  assert.strictEqual((await adm(`/admin/departments/${made.data.id}/status`, { method: 'PATCH', json: { is_active: 'no' } })).status, 400, 'strict boolean');
  assert.strictEqual((await adm(`/admin/departments/${made.data.id}/status`, { method: 'PATCH', json: { is_active: false } })).data.is_active, false);
  assert.strictEqual((await pool.query('SELECT department FROM users WHERE id=$1', [stu.id])).rows[0].department, `Dept ${P} Beta`, 'existing students are untouched');
  const target = await makeUser({ role: 'student' });
  assert.strictEqual((await adm(`/admin/users/${target.id}/academic`, { method: 'PATCH', json: { department: `Dept ${P} Beta` } })).status, 400, 'inactive department cannot be assigned');
  assert.strictEqual((await adm(`/admin/departments/${made.data.id}`, { method: 'DELETE' })).status, 404, 'there is no delete endpoint');
  assert.strictEqual((await auditFor('DEPARTMENT_DEACTIVATED', made.data.id)).length, 1);
  await adm(`/admin/departments/${made.data.id}/status`, { method: 'PATCH', json: { is_active: false } });
  assert.strictEqual((await auditFor('DEPARTMENT_DEACTIVATED', made.data.id)).length, 1, 'repeating a state change is not logged twice');
});

test('programmes: configured list drives CSV import; rename follows students', async () => {
  const c = code(3);
  const made = await adm('/admin/programmes', { method: 'POST', json: { code: c, name: `Prog ${P}` } });
  assert.strictEqual(made.status, 201); created.prog.push(made.data.id);
  assert.strictEqual((await adm('/admin/programmes', { method: 'POST', json: { code: code(4), name: `prog-${P}`.replace('-', ' ') } })).status, 409, 'same name ignoring case');
  assert.strictEqual((await adm('/admin/programmes', { method: 'POST', json: { code: c, name: 'Other' } })).status, 409, 'same code');
  assert.strictEqual((await adm('/admin/programmes', { method: 'POST', json: { code: code(8), name: `Prog.${P}` } })).status, 409, 'same name apart from punctuation/spacing (the database index alone would not catch this)');
  assert.strictEqual((await adm('/admin/programmes', { method: 'POST', json: { code: 'X', name: 'Bad' } })).status, 400);
  assert.strictEqual((await adm('/admin/programmes', { method: 'POST', json: { code: code(5), name: '=cmd|bad' } })).status, 400);
  // the existing default still resolves despite different spelling
  const v = require('../src/utils/validation');
  const lookup = new Map([[v.programmeKey('BTech'), { name: 'BTech', is_active: true }], [v.programmeKey('Old'), { name: 'Old', is_active: false }]]);
  const ctx = { deptLookup: new Map([['cse', { name: 'CSE', is_active: true }]]), programmeLookup: lookup };
  const row = (programme) => v.validateStudentRow({ student_id: 'STU001', name: 'A Student', email: 'a@x.edu', department: 'cse', programme, academic_year: '2025-26', semester: '3' }, ctx);
  assert.strictEqual(row('b.tech').value.programme, 'BTech', 'canonical spelling is stored');
  assert.ok(row('Nope').errors.some((e) => /not configured/.test(e)));
  assert.ok(row('Old').errors.some((e) => /inactive/.test(e)));

  const stu = await makeUser({ role: 'student' });
  await pool.query('UPDATE users SET programme=$1 WHERE id=$2', [`Prog ${P}`, stu.id]);
  const ren = await adm(`/admin/programmes/${made.data.id}`, { method: 'PUT', json: { name: `Prog ${P} v2` } });
  assert.strictEqual(ren.status, 200);
  assert.strictEqual((await pool.query('SELECT programme FROM users WHERE id=$1', [stu.id])).rows[0].programme, `Prog ${P} v2`);
  assert.strictEqual((await auditFor('PROGRAMME_UPDATED', made.data.id))[0].details.students_updated, 1);
  assert.strictEqual((await adm(`/admin/programmes/${made.data.id}/status`, { method: 'PATCH', json: { is_active: false } })).status, 200);
  assert.strictEqual((await adm('/admin/programmes')).data.find((p) => p.id === made.data.id).student_count, 1);
});

test('academic years: strict format, no silent overwrite, one current year, closing keeps records and blocks new submissions', async () => {
  const yr = 2060 + (Date.now() % 30); // far-future years (the format check allows up to 2100) that cannot clash with real data
  const name = `${yr}-${yr + 1}`;
  for (const bad of [{ name: '2025', current_semester: 1 }, { name: '2025-2027', current_semester: 1 }, { name: `${name}`, current_semester: 0 }, { name: `${name}`, current_semester: 13 }, { name: `${name}`, current_semester: 'x' }, { name: `${name}`, current_semester: 3, is_current: 'yes' }]) {
    assert.strictEqual((await adm('/admin/sessions', { method: 'POST', json: bad })).status, 400, JSON.stringify(bad));
  }
  // an unreachable year (> next calendar year) cannot be used by students, so use a real, recent one for the submission part below
  const made = await adm('/admin/sessions', { method: 'POST', json: { name: `${yr}-${String(yr + 1).slice(2)}`, current_semester: 'Semester 4' } });
  if (made.data?.id) created.sess.push(made.data.id); // registered first so cleanup works even if an assertion below fails
  assert.strictEqual(made.status, 201, JSON.stringify(made.data));
  assert.strictEqual(made.data.name, name);
  assert.strictEqual(made.data.current_semester, '4');
  assert.strictEqual(made.data.current_semester_number, 4);
  assert.strictEqual(made.data.is_current, false);
  const dupYear = await adm('/admin/sessions', { method: 'POST', json: { name, current_semester: 7 } });
  assert.strictEqual(dupYear.status, 409, 'no silent overwrite');
  assert.match(dupYear.data.error, /Edit it instead/, 'friendly message, not the raw database error');
  assert.strictEqual((await adm('/admin/sessions')).data.find((s) => s.id === made.data.id).current_semester, '4');
  assert.strictEqual((await adm(`/admin/sessions/${made.data.id}`, { method: 'PUT', json: { current_semester: 6 } })).data.current_semester, '6');
  assert.strictEqual((await adm(`/admin/sessions/${made.data.id}`, { method: 'PUT', json: { current_semester: 99 } })).status, 400);

  const before = (await pool.query('SELECT id FROM academic_sessions WHERE is_current')).rows.map((r) => r.id);
  try {
    const set = await adm(`/admin/sessions/${made.data.id}/set-current`, { method: 'PATCH' });
    assert.strictEqual(set.status, 200);
    const nowCurrent = (await pool.query('SELECT id FROM academic_sessions WHERE is_current')).rows.map((r) => r.id);
    assert.deepStrictEqual(nowCurrent, [made.data.id], 'exactly one current year');
    assert.strictEqual((await adm(`/admin/sessions/${made.data.id}/archive`, { method: 'PATCH', json: { archived: true } })).status, 409, 'cannot close the current year');
  } finally {
    // put the original current year back so this test always leaves the system as it found it
    await pool.query('UPDATE academic_sessions SET is_current = FALSE WHERE is_current');
    if (before[0]) await pool.query('UPDATE academic_sessions SET is_current = TRUE WHERE id = $1', [before[0]]);
    await pool.query('UPDATE academic_sessions SET is_archived = FALSE WHERE id = $1', [made.data.id]);
  }
  assert.deepStrictEqual((await pool.query('SELECT id FROM academic_sessions WHERE is_current')).rows.map((r) => r.id), before);
  assert.strictEqual((await adm('/admin/sessions/999999999/set-current', { method: 'PATCH' })).status, 404);
  assert.strictEqual((await auditFor('SESSION_SET_CURRENT', made.data.id)).length, 1);

  // closing a year: old records stay, new submissions to it are refused, the form stops offering it
  const thisYear = new Date().getFullYear();
  const real = `${thisYear - 4}-${thisYear - 3}`; // an old year, so the live "current" year is never touched
  const ex = (await pool.query('SELECT id, is_archived FROM academic_sessions WHERE name=$1', [real])).rows[0];
  let sessId = ex?.id;
  if (!sessId) { sessId = (await adm('/admin/sessions', { method: 'POST', json: { name: real, current_semester: 2 } })).data.id; created.sess.push(sessId); }
  const stu = await makeUser({ role: 'student' });
  const old = await submit(stu, { academic_session: real });
  assert.strictEqual((await adm(`/admin/sessions/${sessId}/archive`, { method: 'PATCH', json: { archived: true } })).status, 200);
  try {
    const refused = await send('/activities', { method: 'POST', token: stu.token, fields: good({ academic_session: real }), file: pdf() });
    assert.strictEqual(refused.status, 400);
    assert.match(refused.data.fields.academic_session, /closed/);
    const draft = await send('/activities/draft', { method: 'POST', token: stu.token, fields: { title: 'Draft in closed year', academic_session: real } });
    assert.strictEqual(draft.status, 400, 'drafts too');
    const opts = (await send('/activities/options', { token: stu.token })).data;
    assert.ok(!opts.open_academic_years.includes(real), 'form no longer offers it');
    assert.ok(opts.academic_years.includes(real), 'filters still know it');
    assert.strictEqual((await send(`/activities/${old.id}`, { token: stu.token })).data.academic_session, real, 'history preserved');
    // an older record can still go through correction in its own (closed) year
    const f = await reviewer();
    assert.strictEqual((await send(`/activities/${old.id}/request-correction`, { method: 'PATCH', token: f.token, json: { notes: 'Please clarify' } })).status, 200);
    const re = await send(`/activities/${old.id}/resubmit`, { method: 'PUT', token: stu.token, fields: { remarks: 'Clarified the role' } });
    assert.strictEqual(re.status, 200, JSON.stringify(re.data));
    pathsToClean.add(await filePathOf(old.id));
    assert.strictEqual((await adm(`/admin/sessions/${sessId}/set-current`, { method: 'PATCH' })).status, 409, 'closed year cannot become current');
  } finally {
    await adm(`/admin/sessions/${sessId}/archive`, { method: 'PATCH', json: { archived: !!ex?.is_archived } });
  }
  assert.strictEqual((await auditFor('SESSION_CLOSED', sessId)).length >= 1, true);
});

test('categories: validation, rename display name only, last active category protected, usage counted', async () => {
  const name = `cat_${P}`.slice(0, 30);
  const made = await adm('/admin/categories', { method: 'POST', json: { name: name.toUpperCase(), display_name: `Cat ${P}` } });
  assert.strictEqual(made.status, 201); created.cat.push(made.data.id);
  assert.strictEqual(made.data.name, name, 'identifier normalised');
  assert.strictEqual((await adm('/admin/categories', { method: 'POST', json: { name, display_name: 'Other' } })).status, 409);
  assert.strictEqual((await adm('/admin/categories', { method: 'POST', json: { name: `${name}2`, display_name: `cat ${P}` } })).status, 409, 'display name clash');
  assert.strictEqual((await adm('/admin/categories', { method: 'POST', json: { name: '!', display_name: 'x' } })).status, 400);
  const ren = await adm(`/admin/categories/${made.data.id}`, { method: 'PUT', json: { display_name: `Cat ${P} Renamed` } });
  assert.strictEqual(ren.status, 200);
  assert.strictEqual(ren.data.name, name, 'identifier never changes');
  assert.strictEqual((await adm(`/admin/categories/${made.data.id}`, { method: 'PUT', json: { name: 'other', display_name: `Cat ${P} Renamed` } })).status, 400, 'nothing to change: only display name is editable');
  assert.strictEqual((await auditFor('CATEGORY_UPDATED', made.data.id))[0].details.to, `Cat ${P} Renamed`);

  // students can use it, and an old activity keeps working after it is deactivated
  const stu = await makeUser({ role: 'student' });
  const act = await submit(stu, { category: name });
  assert.strictEqual((await adm('/admin/categories')).data.find((c) => c.id === made.data.id).usage_count, 1);
  assert.strictEqual((await adm(`/admin/categories/${made.data.id}/status`, { method: 'PATCH', json: { is_active: false } })).status, 200);
  assert.strictEqual((await send(`/activities/${act.id}`, { token: stu.token })).data.category, name, 'history unchanged');
  const refused = await send('/activities', { method: 'POST', token: stu.token, fields: good({ category: name }), file: pdf() });
  assert.strictEqual(refused.status, 400, 'deactivated category takes no new submissions');
  assert.ok(!(await send('/activities/options', { token: stu.token })).data.categories.some((c) => c.name === name));

  // the last active category cannot be switched off (done in a transaction so nothing leaks)
  const active = (await pool.query('SELECT id FROM categories WHERE is_active ORDER BY id')).rows.map((r) => r.id);
  const keep = active[0];
  await pool.query('UPDATE categories SET is_active = FALSE WHERE is_active AND id <> $1', [keep]);
  try {
    assert.strictEqual((await adm(`/admin/categories/${keep}/status`, { method: 'PATCH', json: { is_active: false } })).status, 409);
  } finally {
    await pool.query('UPDATE categories SET is_active = TRUE WHERE id = ANY($1)', [active]);
    await pool.query('UPDATE categories SET is_active = FALSE WHERE id = $1', [made.data.id]);
  }
});

test('academic assignment: students and faculty, only active targets, before/after audited', async () => {
  const d = await adm('/admin/departments', { method: 'POST', json: { code: code(6), name: `Dept ${P} Assign` } }); created.dept.push(d.data.id);
  const stu = await makeUser({ role: 'student' }); const fac = await makeUser({ role: 'faculty' }); const admin2 = await makeUser({ role: 'admin' });
  const set = (u, json) => adm(`/admin/users/${u.id}/academic`, { method: 'PATCH', json });
  const ok = await set(stu, { department: d.data.code.toLowerCase(), programme: 'b.tech', academic_year: '2025-26', semester: '4' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
  assert.deepStrictEqual([ok.data.department, ok.data.programme, ok.data.academic_year, ok.data.semester], [d.data.name, 'BTech', '2025-2026', '4']);
  assert.ok(!('password_hash' in ok.data));
  const log = (await auditFor('DEPARTMENT_ASSIGNED', stu.id))[0];
  assert.strictEqual(log.details.to.department, d.data.name);
  assert.strictEqual(log.details.from.department, 'Computer Science & Engineering');
  assert.strictEqual(log.actor_id, (await pool.query(`SELECT id FROM users WHERE email=$1`, [log.actor_label])).rows[0].id, 'actor label filled in');
  assert.strictEqual((await set(stu, { semester: '4' })).status, 400, 'no change');
  assert.strictEqual((await set(stu, { semester: '0' })).status, 400);
  assert.strictEqual((await set(stu, { programme: 'Underwater Basket Weaving' })).status, 400);
  const pr = await adm('/admin/programmes', { method: 'POST', json: { code: code(9), name: `Prog ${P} Closed` } }); created.prog.push(pr.data.id);
  await adm(`/admin/programmes/${pr.data.id}/status`, { method: 'PATCH', json: { is_active: false } });
  assert.strictEqual((await set(stu, { programme: `Prog ${P} Closed` })).status, 400, 'inactive programme cannot be assigned');
  assert.strictEqual((await set(stu, { department: 'No Such Dept' })).status, 400);
  assert.strictEqual((await set(stu, { role: 'admin' })).status, 400, 'cannot smuggle other fields');
  assert.strictEqual((await set(stu, { email: 'x@y.z' })).status, 400);
  assert.strictEqual((await pool.query('SELECT role FROM users WHERE id=$1', [stu.id])).rows[0].role, 'student');
  const f = await set(fac, { department: d.data.name });
  assert.strictEqual(f.status, 200);
  assert.strictEqual((await set(fac, { programme: 'BTech' })).status, 400, 'faculty have no programme');
  assert.strictEqual((await set(admin2, { department: d.data.name })).status, 400, 'admins have no academic assignment');
  assert.strictEqual((await set({ id: 999999999 }, { department: d.data.name })).status, 404);
  // faculty verification scope is a separate control and was not touched
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM faculty_scopes WHERE faculty_id=$1 AND department=$2', [fac.id, d.data.name])).rows[0].n, 0);
});

test('administrator audit log: records the events, filters, pages, is read-only and holds no secrets', async () => {
  const d = await adm('/admin/departments', { method: 'POST', json: { code: code(7), name: `Dept ${P} Audit` } }); created.dept.push(d.data.id);
  const read = (qs) => adm(`/admin/audit?${qs}`);
  const all = await read('limit=100');
  assert.strictEqual(all.status, 200);
  const mine = all.data.entries.find((e) => e.action === 'DEPARTMENT_CREATED' && e.target_id === String(d.data.id));
  assert.ok(mine, 'new event is listed');
  assert.ok(mine.actor_name && mine.created_at);
  assert.ok(all.data.actions.includes('DEPARTMENT_CREATED'));
  assert.ok((await read(`action=DEPARTMENT_CREATED&search=${d.data.id}&limit=100`)).data.entries.some((e) => e.target_id === String(d.data.id)), 'search by target id (substring match)');
  assert.deepStrictEqual((await read(`search=${encodeURIComponent(`Dept ${P} Audit`)}&limit=100`)).data.entries.map((e) => e.action), ['DEPARTMENT_CREATED'], 'search also looks inside the details (e.g. a department name)');
  assert.ok((await read('action=DEPARTMENT_CREATED&limit=100')).data.entries.every((e) => e.action === 'DEPARTMENT_CREATED'));
  assert.ok((await read('target_type=department&limit=100')).data.entries.every((e) => e.target_type === 'department'));
  assert.strictEqual((await read('search=%25&action=DEPARTMENT_CREATED')).data.entries.length, 0, 'a literal % is not a wildcard');
  assert.strictEqual((await read('date_from=2999-01-01')).data.entries.length, 0);
  const today = (await pool.query(`SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') d`)).rows[0].d;
  assert.ok((await read(`date_from=${today}&date_to=${today}&limit=100`)).data.entries.some((e) => e.id === mine.id));
  for (const bad of ['date_from=nope', 'date_from=2026-05-02&date_to=2026-05-01']) assert.strictEqual((await read(bad)).status, 400, bad);
  const p1 = (await read('limit=2&page=1')).data; const p2 = (await read('limit=2&page=2')).data;
  assert.strictEqual(p1.entries.length, 2);
  assert.ok(p1.pages >= 2 && p1.entries[0].id > p1.entries[1].id && p1.entries[1].id > p2.entries[0].id, 'newest first, pages contiguous');
  assert.strictEqual((await read('limit=100000')).data.limit, 100, 'page size capped');
  // read-only
  await assert.rejects(pool.query('UPDATE admin_audit_log SET action = $1 WHERE id = $2', ['X', mine.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM admin_audit_log WHERE id = $1', [mine.id]), /append-only/);
  // no secrets in anything we log
  const dump = JSON.stringify((await pool.query('SELECT details FROM admin_audit_log ORDER BY id DESC LIMIT 500')).rows);
  assert.doesNotMatch(dump, /password|token_hash|\$2[aby]\$|jwt/i);
});

test('administrative review override is recorded; overview counts are real', async () => {
  const stu = await makeUser({ role: 'student' });
  const a = await submit(stu); const b = await submit(stu);
  const ov = await send(`/activities/${a.id}/approve`, { method: 'PATCH', token: adminToken, json: { remarks: 'Verified in person' } });
  assert.strictEqual(ov.status, 200);
  const rec = (await auditFor('REVIEW_OVERRIDE', a.id))[0];
  assert.deepStrictEqual([rec.details.decision, rec.details.from, rec.details.version, rec.details.student_id], ['approved', 'pending', 1, stu.id]);
  const f = await reviewer();
  await send(`/activities/${b.id}/approve`, { method: 'PATCH', token: f.token, json: {} });
  assert.strictEqual((await auditFor('REVIEW_OVERRIDE', b.id)).length, 0, 'normal faculty decisions are not overrides');
  await send('/activities/draft', { method: 'POST', token: stu.token, fields: { title: 'Only a draft' } });
  const o = (await adm('/admin/overview')).data;
  const db = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status <> 'draft')::int total, COUNT(*) FILTER (WHERE status IN ('pending','resubmitted'))::int pending,
      COUNT(*) FILTER (WHERE status='approved')::int approved, COUNT(*) FILTER (WHERE status='draft')::int drafts FROM activities`)).rows[0];
  assert.deepStrictEqual([o.activities.total_activities, o.activities.pending, o.activities.approved, o.activities.drafts], [db.total, db.pending, db.approved, db.drafts]);
});
