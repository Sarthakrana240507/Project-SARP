// Phase 4 tests: faculty provisioning, faculty CSV import, verification scope enforcement,
// Super Admin rules, create-admin CLI, demo-seed production guard.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawnSync } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');
const app = require('../src/server');
const { initSchema } = require('../src/models/schema');
const { rateLimit } = require('../src/middleware/rateLimit');
const v = require('../src/utils/validation');
const { setScope } = require('../src/utils/scope');
const { sha256 } = require('../src/utils/tokens');

const PASSWORD = 'TestPass@12345';
const P = `p4${Date.now()}`;
let server; let base; let superToken; let superId; let adminToken; let adminId;
let seq = 0;
const logged = [];
const origLog = { log: console.log, error: console.error, warn: console.warn };
const secrets = [];

async function api(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const login = async (email) => (await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).data.token;
const uniq = () => `${P}x${++seq}`;

// Creates an ACTIVE user straight in the database (fast fixture) and returns { id, email, token }.
async function makeUser({ role, department = 'Computer Science & Engineering', superAdmin = false, scope }) {
  const n = uniq();
  const hash = await bcrypt.hash(PASSWORD, 4);
  const email = `${n}@college.test`;
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, status, is_active, department, is_super_admin, employee_id, enrollment_no)
     VALUES ($1,$2,$3,$4,'ACTIVE',TRUE,$5,$6,$7,$8) RETURNING id`,
    [`User ${n}`, email, hash, role, department, superAdmin, role === 'faculty' ? n.toUpperCase() : null, role === 'student' ? n.toUpperCase() : null]);
  const id = r.rows[0].id;
  if (role === 'faculty') await setScope(pool, id, scope || { all: false, departments: [department] }, null);
  return { id, email, token: await login(email) };
}
async function activity(studentId, title = 'Hackathon') {
  return (await pool.query(
    `INSERT INTO activities (student_id, title, category, status) VALUES ($1,$2,'Hackathon','pending') RETURNING id`, [studentId, `${P} ${title}`])).rows[0].id;
}
const auditActions = async (target) =>
  (await pool.query(`SELECT action, details, actor_label FROM admin_audit_log WHERE target_id = $1 ORDER BY id`, [String(target)])).rows;
const newFaculty = (extra = {}) => {
  const n = uniq();
  return { faculty_id: `${n}F`, name: `Prof ${n}`, email: `${n}@college.test`, department: 'CSE', designation: 'Assistant Professor', ...extra };
};
const tokenOf = (link) => { const t = link.split('#token=')[1]; secrets.push(t); return t; };

test.before(async () => {
  for (const k of ['log', 'error', 'warn']) console[k] = (...a) => { logged.push(a.map(String).join(' ')); origLog[k](...a); };
  await initSchema();
  await new Promise((r) => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  const s = await makeUser({ role: 'admin', superAdmin: true });
  superId = s.id; superToken = s.token;
  const a = await makeUser({ role: 'admin' });
  adminId = a.id; adminToken = a.token;
});
test.beforeEach(() => rateLimit.resetAll());
test.after(async () => {
  Object.assign(console, origLog);
  const ids = (await pool.query(`SELECT id FROM users WHERE email LIKE $1`, [`${P}%`])).rows.map((r) => r.id);
  await pool.query('DELETE FROM activities WHERE student_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM import_batches WHERE uploaded_by = ANY($1)', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ---------------------------------------------------------------- validators
test('faculty row validator: required fields, formats, department, designation', () => {
  const lookup = new Map([['cse', { name: 'Computer Science & Engineering', is_active: true }], ['old', { name: 'Old', is_active: false }]]);
  const ok = v.validateFacultyRow({ faculty_id: 'f-01', name: 'Dr A', email: 'A@College.test', department: 'cse', designation: 'Professor' }, { deptLookup: lookup });
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.value.faculty_id, 'F-01');
  assert.strictEqual(ok.value.email, 'a@college.test');
  assert.strictEqual(ok.value.department, 'Computer Science & Engineering');
  const bad = v.validateFacultyRow({ faculty_id: '', name: '=cmd', email: 'nope', department: 'old', designation: '<x>' }, { deptLookup: lookup });
  assert.ok(bad.errors.length >= 5, bad.errors.join('|'));
  assert.strictEqual(bad.value, null);
});

// ---------------------------------------------------------------- provisioning
test('admin creates a faculty account: INVITED, no password, default scope = own department, audited, honest about email', async () => {
  const body = newFaculty();
  const r = await api('/admin/faculty', { method: 'POST', token: adminToken, body });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.faculty.status, 'INVITED');
  assert.deepStrictEqual(r.data.faculty.scope, { all: false, departments: ['Computer Science & Engineering'] });
  assert.strictEqual(r.data.invitation.mode, 'NONE');
  assert.ok(!JSON.stringify(r.data).includes('password'));
  const row = (await pool.query('SELECT password_hash, role, is_active FROM users WHERE id = $1', [r.data.faculty.id])).rows[0];
  assert.strictEqual(row.password_hash, null);
  assert.strictEqual(row.role, 'faculty');
  assert.strictEqual(row.is_active, false);
  assert.ok((await auditActions(r.data.faculty.id)).some((a) => a.action === 'FACULTY_CREATED'));
});

test('faculty creation rejects bad input and duplicates; only admins may call it', async () => {
  const good = newFaculty();
  assert.strictEqual((await api('/admin/faculty', { method: 'POST', token: adminToken, body: good })).status, 201);
  assert.strictEqual((await api('/admin/faculty', { method: 'POST', token: adminToken, body: { ...good, faculty_id: `${uniq()}F` } })).status, 409, 'duplicate email');
  assert.strictEqual((await api('/admin/faculty', { method: 'POST', token: adminToken, body: { ...newFaculty(), faculty_id: good.faculty_id.toLowerCase() } })).status, 409, 'duplicate id, any case');
  assert.strictEqual((await api('/admin/faculty', { method: 'POST', token: adminToken, body: newFaculty({ email: 'bad' }) })).status, 400);
  assert.strictEqual((await api('/admin/faculty', { method: 'POST', token: adminToken, body: newFaculty({ department: 'Nowhere' }) })).status, 400);
  assert.strictEqual((await api('/admin/faculty', { method: 'POST', token: adminToken, body: { ...newFaculty(), scope: { departments: ['Nowhere'] } } })).status, 400);
  const fac = await makeUser({ role: 'faculty' });
  const stu = await makeUser({ role: 'student' });
  for (const t of [fac.token, stu.token, undefined]) {
    assert.ok([401, 403].includes((await api('/admin/faculty', { method: 'POST', token: t, body: newFaculty() })).status));
    assert.ok([401, 403].includes((await api('/admin/faculty', { token: t })).status));
  }
});

test('faculty update: email is not editable, changes are audited, duplicate ids refused', async () => {
  const a = (await api('/admin/faculty', { method: 'POST', token: adminToken, body: newFaculty() })).data.faculty;
  const b = (await api('/admin/faculty', { method: 'POST', token: adminToken, body: newFaculty() })).data.faculty;
  const u = await api(`/admin/faculty/${a.id}`, { method: 'PUT', token: adminToken, body: { name: 'Renamed Prof', designation: 'Professor', email: 'hijack@college.test' } });
  assert.strictEqual(u.status, 200, JSON.stringify(u.data));
  assert.deepStrictEqual(u.data.changed.sort(), ['designation', 'name']);
  assert.strictEqual(u.data.faculty.email, a.email, 'email unchanged');
  assert.ok((await auditActions(a.id)).some((x) => x.action === 'FACULTY_UPDATED'));
  assert.strictEqual((await api(`/admin/faculty/${a.id}`, { method: 'PUT', token: adminToken, body: { employee_id: b.employee_id } })).status, 409);
  assert.strictEqual((await api('/admin/faculty/999999999', { method: 'PUT', token: adminToken, body: { name: 'Nobody Here' } })).status, 404);
});

test('faculty list: search, department filter, status filter, pagination, scope included', async () => {
  const f = (await api('/admin/faculty', { method: 'POST', token: adminToken, body: newFaculty({ department: 'ECE', name: `Zed ${P}` }) })).data.faculty;
  const s = await api(`/admin/faculty?search=${encodeURIComponent(`Zed ${P}`)}`, { token: adminToken });
  assert.strictEqual(s.data.total, 1);
  assert.strictEqual(s.data.faculty[0].id, f.id);
  assert.ok(s.data.faculty[0].scope);
  assert.strictEqual((await api(`/admin/faculty?search=${P}&department=${encodeURIComponent('Electronics & Communication')}`, { token: adminToken })).data.total >= 1, true);
  assert.strictEqual((await api(`/admin/faculty?search=${P}&account_status=SUSPENDED`, { token: adminToken })).data.total, 0);
  const pg = await api(`/admin/faculty?search=${P}&limit=2&page=1`, { token: adminToken });
  assert.strictEqual(pg.data.faculty.length, 2);
  assert.ok(pg.data.total > 2);
});

// ---------------------------------------------------------------- CSV import
const FHEADER = 'faculty_id,name,email,department,designation';
async function uploadFaculty(csv, token = adminToken) {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'faculty.csv');
  const res = await fetch(base + '/admin/faculty/import/preview', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('faculty CSV import: preview writes nothing, errors per row, confirm creates INVITED faculty with default scope', async () => {
  const n = uniq();
  const csv = [FHEADER,
    `${n}A,Prof One,${n}a@college.test,CSE,Professor`,
    `${n}B,Prof Two,${n}b@college.test,ECE,`,
    `${n}C,Bad Email,not-an-email,CSE,`,
    `${n}A,Dup Id,${n}d@college.test,CSE,`,
  ].join('\n') + '\n';
  const p = await uploadFaculty(csv);
  assert.strictEqual(p.status, 200, JSON.stringify(p.data));
  assert.strictEqual(p.data.valid_rows, 2);
  assert.strictEqual(p.data.error_rows, 2);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM users WHERE email LIKE $1`, [`${n}%`])).rows[0].n, 0, 'nothing written at preview');

  // A student batch id must not be confirmable on the faculty path (and vice versa).
  const sb = (await pool.query(`INSERT INTO import_batches (kind, filename, uploaded_by, status, payload) VALUES ('STUDENT','x.csv',$1,'PREVIEW','[]') RETURNING id`, [adminId])).rows[0].id;
  assert.strictEqual((await api(`/admin/faculty/import/${sb}/confirm`, { method: 'POST', token: adminToken, body: {} })).status, 404);

  const c = await api(`/admin/faculty/import/${p.data.batch_id}/confirm`, { method: 'POST', token: adminToken, body: {} });
  assert.strictEqual(c.status, 200, JSON.stringify(c.data));
  assert.strictEqual(c.data.imported, 2);
  assert.strictEqual(c.data.invitations.mode, 'NONE');
  const rows = (await pool.query(`SELECT id, role, status, department, designation FROM users WHERE email LIKE $1 ORDER BY email`, [`${n}%`])).rows;
  assert.deepStrictEqual(rows.map((r) => [r.role, r.status]), [['faculty', 'INVITED'], ['faculty', 'INVITED']]);
  const sc = await pool.query(`SELECT faculty_id, department FROM faculty_scopes WHERE faculty_id = ANY($1)`, [rows.map((r) => r.id)]);
  assert.strictEqual(sc.rows.length, 2);
  for (const s of sc.rows) assert.strictEqual(s.department, rows.find((r) => r.id === s.faculty_id).department);
  assert.strictEqual((await api(`/admin/faculty/import/${p.data.batch_id}/confirm`, { method: 'POST', token: adminToken, body: {} })).status, 409, 'cannot confirm twice');

  const hist = await api('/admin/imports?kind=FACULTY', { token: adminToken });
  assert.ok(hist.data.imports.some((i) => i.id === p.data.batch_id));
  assert.ok(hist.data.imports.every((i) => i.kind === 'FACULTY'));
  assert.ok((await auditActions(p.data.batch_id)).some((a) => a.action === 'FACULTY_IMPORT'));

  const links = await fetch(`${base}/admin/imports/${p.data.batch_id}/activation-links`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
  const text = await links.text();
  assert.ok(text.startsWith('faculty_id,'), text.slice(0, 40));
  assert.strictEqual(text.trim().split(/\r?\n/).length, 3);
});

test('faculty CSV import: wrong columns and non-admin callers are refused', async () => {
  assert.strictEqual((await uploadFaculty('student_id,name\nx,y\n')).status, 400);
  const fac = await makeUser({ role: 'faculty' });
  assert.strictEqual((await uploadFaculty(`${FHEADER}\n`, fac.token)).status, 403);
});

// ---------------------------------------------------------------- activation
test('invited faculty activates with a hand-off link, signs in, and /auth/me reports the verification scope', async () => {
  const f = (await api('/admin/faculty', { method: 'POST', token: adminToken, body: newFaculty() })).data.faculty;
  const l = await api(`/admin/users/${f.id}/activation-link`, { method: 'POST', token: adminToken, body: { delivery: 'HANDOFF' } });
  assert.strictEqual(l.status, 200);
  const t = tokenOf(l.data.link);
  assert.strictEqual((await api('/auth/activate', { method: 'POST', body: { token: t, password: PASSWORD } })).status, 200);
  const tok = await login(f.email);
  const me = await api('/auth/me', { token: tok });
  assert.strictEqual(me.data.user.role, 'faculty');
  assert.deepStrictEqual(me.data.user.verification_scope, { all: false, departments: ['Computer Science & Engineering'] });
  assert.ok(!('password_hash' in me.data.user));
});

// ---------------------------------------------------------------- scope enforcement
test('scope: a CSE-only reviewer sees, opens, reviews and exports only CSE students', async () => {
  const cse = await makeUser({ role: 'student', department: 'Computer Science & Engineering' });
  const ece = await makeUser({ role: 'student', department: 'Electronics & Communication' });
  const fac = await makeUser({ role: 'faculty', department: 'Computer Science & Engineering' });
  const aCse = await activity(cse.id, 'cse');
  const aEce = await activity(ece.id, 'ece');

  const pending = (await api('/activities/pending?limit=50&sort=newest', { token: fac.token })).data.activities.map((a) => a.id);
  assert.ok(pending.includes(aCse));
  assert.ok(!pending.includes(aEce), 'ECE activity must not appear in queue');

  assert.strictEqual((await api(`/activities/${aCse}`, { token: fac.token })).status, 200);
  assert.strictEqual((await api(`/activities/${aEce}`, { token: fac.token })).status, 403);
  assert.strictEqual((await api(`/activities/${aEce}/audit`, { token: fac.token })).status, 403);
  assert.strictEqual((await api(`/portfolio/${ece.id}`, { token: fac.token })).status, 403);
  assert.strictEqual((await api(`/portfolio/${ece.id}/data`, { token: fac.token })).status, 403);
  assert.strictEqual((await api(`/portfolio/${cse.id}/data`, { token: fac.token })).status, 200);

  for (const [m, p, body] of [['PATCH', 'approve', {}], ['PATCH', 'reject', { remarks: 'no' }], ['PATCH', 'request-correction', { notes: 'fix' }]]) {
    const r = await api(`/activities/${aEce}/${p}`, { method: m, token: fac.token, body });
    assert.strictEqual(r.status, 403, `${p}: ${JSON.stringify(r.data)}`);
  }
  assert.strictEqual((await pool.query('SELECT status FROM activities WHERE id = $1', [aEce])).rows[0].status, 'pending', 'out-of-scope activity untouched');
  assert.strictEqual((await api(`/activities/${aCse}/approve`, { method: 'PATCH', token: fac.token, body: {} })).status, 200);

  // history only lists in-scope students
  const hist = (await api('/activities/history?limit=50', { token: fac.token })).data.activities.map((a) => a.id);
  assert.ok(hist.includes(aCse) && !hist.includes(aEce));

  // analytics totals count only in-scope activities
  const an = await api('/analytics', { token: fac.token });
  const all = await api('/analytics', { token: adminToken });
  assert.strictEqual(an.status, 200);
  assert.ok(an.data.totals.total_activities < all.data.totals.total_activities);
  const csv = await fetch(`${base}/analytics/export/csv`, { headers: { Authorization: `Bearer ${fac.token}` } });
  assert.ok(!(await csv.text()).includes(`${P} ece`), 'CSV export leaks nothing out of scope');
});

test('scope: all-departments, multi-department, and empty scopes; admin changes apply immediately', async () => {
  const cse = await makeUser({ role: 'student', department: 'Computer Science & Engineering' });
  const ece = await makeUser({ role: 'student', department: 'Electronics & Communication' });
  const aCse = await activity(cse.id); const aEce = await activity(ece.id);
  const fac = await makeUser({ role: 'faculty', scope: { all: true, departments: [] } });
  const ids = async () => (await api('/activities/pending?limit=50&sort=newest', { token: fac.token })).data.activities.map((a) => a.id);
  let q = await ids(); assert.ok(q.includes(aCse) && q.includes(aEce), 'all departments');

  let r = await api(`/admin/faculty/${fac.id}/scope`, { method: 'PUT', token: adminToken, body: { departments: ['ECE'] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.scope, { all: false, departments: ['Electronics & Communication'] });
  q = await ids(); assert.ok(!q.includes(aCse) && q.includes(aEce), 'narrowed immediately, same token');

  await api(`/admin/faculty/${fac.id}/scope`, { method: 'PUT', token: adminToken, body: { departments: ['CSE', 'ECE', 'cse'] } });
  q = await ids(); assert.ok(q.includes(aCse) && q.includes(aEce), 'multi-department');

  await api(`/admin/faculty/${fac.id}/scope`, { method: 'PUT', token: adminToken, body: { departments: [] } });
  q = await ids(); assert.ok(!q.includes(aCse) && !q.includes(aEce), 'empty scope = no access');
  assert.strictEqual((await api(`/activities/${aCse}`, { token: fac.token })).status, 403);

  assert.strictEqual((await api(`/admin/faculty/${fac.id}/scope`, { method: 'PUT', token: adminToken, body: { departments: ['Atlantis'] } })).status, 400);
  assert.strictEqual((await api(`/admin/faculty/${fac.id}/scope`, { method: 'PUT', token: adminToken, body: {} })).status, 400);
  assert.strictEqual((await api(`/admin/faculty/${cse.id}/scope`, { method: 'PUT', token: adminToken, body: { all: true } })).status, 404, 'not a faculty account');
  const acts = (await auditActions(fac.id)).filter((x) => x.action === 'FACULTY_SCOPE_CHANGED');
  assert.strictEqual(acts.length, 3);
  const note = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Verification Scope Updated'`, [fac.id]);
  assert.ok(note.rows.length >= 3);
});

test('scope: only admins can change scope; students keep seeing only themselves; admin sees everything', async () => {
  const stu = await makeUser({ role: 'student' });
  const other = await makeUser({ role: 'student' });
  const fac = await makeUser({ role: 'faculty' });
  assert.strictEqual((await api(`/admin/faculty/${fac.id}/scope`, { method: 'PUT', token: fac.token, body: { all: true } })).status, 403);
  assert.strictEqual((await api(`/admin/faculty/${fac.id}/scope`, { method: 'PUT', token: stu.token, body: { all: true } })).status, 403);
  const aOther = await activity(other.id);
  assert.strictEqual((await api(`/activities/${aOther}`, { token: stu.token })).status, 403);
  assert.strictEqual((await api(`/portfolio/${other.id}`, { token: stu.token })).status, 403);
  assert.strictEqual((await api('/activities/pending', { token: stu.token })).status, 403);
  assert.strictEqual((await api(`/activities/${aOther}`, { token: adminToken })).status, 200);
});

// ---------------------------------------------------------------- Super Admin rules
test('Super Admin: only a Super Admin manages administrators; regular admins are refused everywhere', async () => {
  assert.strictEqual((await api('/admin/administrators', { token: adminToken })).status, 403);
  assert.strictEqual((await api('/admin/administrators', { method: 'POST', token: adminToken, body: { name: 'Eve', email: `${uniq()}@college.test` } })).status, 403);
  assert.strictEqual((await api('/admin/administrators', { token: superToken })).status, 200);

  const email = `${uniq()}@college.test`;
  const c = await api('/admin/administrators', { method: 'POST', token: superToken, body: { name: 'New Admin', email } });
  assert.strictEqual(c.status, 201, JSON.stringify(c.data));
  assert.strictEqual(c.data.administrator.status, 'INVITED');
  assert.strictEqual((await api('/admin/administrators', { method: 'POST', token: superToken, body: { name: 'New Admin', email } })).status, 409);
  const id = c.data.administrator.id;

  // regular admin cannot hand out a link, suspend, or change role of an admin account
  assert.strictEqual((await api(`/admin/users/${id}/activation-link`, { method: 'POST', token: adminToken, body: { delivery: 'HANDOFF' } })).status, 403);
  assert.strictEqual((await api(`/admin/users/${superId}/status`, { method: 'PATCH', token: adminToken, body: { status: 'SUSPENDED' } })).status, 403);
  assert.strictEqual((await api(`/admin/users/${id}/role`, { method: 'PATCH', token: adminToken, body: { role: 'student' } })).status, 403);
  // super admin can
  const l = await api(`/admin/users/${id}/activation-link`, { method: 'POST', token: superToken, body: { delivery: 'HANDOFF' } });
  assert.strictEqual(l.status, 200);
  tokenOf(l.data.link);
  assert.ok((await auditActions(id)).some((a) => a.action === 'ADMINISTRATOR_CREATED'));
});

test('Super Admin: promoting/demoting, no self change, role-change rules', async () => {
  const target = await makeUser({ role: 'admin' });
  assert.strictEqual((await api(`/admin/administrators/${target.id}/super`, { method: 'PATCH', token: adminToken, body: { super: true } })).status, 403);
  assert.strictEqual((await api(`/admin/administrators/${superId}/super`, { method: 'PATCH', token: superToken, body: { super: false } })).status, 400, 'no self change');
  assert.strictEqual((await api(`/admin/administrators/${target.id}/super`, { method: 'PATCH', token: superToken, body: { super: 'yes' } })).status, 400);
  assert.strictEqual((await api(`/admin/administrators/${target.id}/super`, { method: 'PATCH', token: superToken, body: { super: true } })).status, 200);
  assert.strictEqual((await api(`/admin/administrators/${target.id}/super`, { method: 'PATCH', token: superToken, body: { super: true } })).status, 400, 'no-op refused');
  // the new super admin acts immediately (role/status are read from the database each request)
  assert.strictEqual((await api('/admin/administrators', { token: target.token })).status, 200);
  assert.strictEqual((await api(`/admin/administrators/${target.id}/super`, { method: 'PATCH', token: superToken, body: { super: false } })).status, 200);
  assert.strictEqual((await api('/admin/administrators', { token: target.token })).status, 403, 'revocation is immediate');
  const actions = (await auditActions(target.id)).map((a) => a.action);
  assert.ok(actions.includes('SUPER_ADMIN_GRANTED') && actions.includes('SUPER_ADMIN_REVOKED'));

  // role changes
  const stu = await makeUser({ role: 'student' });
  assert.strictEqual((await api(`/admin/users/${stu.id}/role`, { method: 'PATCH', token: adminToken, body: { role: 'admin' } })).status, 403, 'regular admin cannot create admins');
  assert.strictEqual((await api(`/admin/users/${adminId}/role`, { method: 'PATCH', token: adminToken, body: { role: 'faculty' } })).status, 400, 'no self change');
  assert.strictEqual((await api(`/admin/users/${stu.id}/role`, { method: 'PATCH', token: adminToken, body: { role: 'student' } })).status, 400, 'no-op refused');
  assert.strictEqual((await api(`/admin/users/${stu.id}/role`, { method: 'PATCH', token: adminToken, body: { role: 'superuser' } })).status, 400);
  assert.strictEqual((await api(`/admin/users/${stu.id}/role`, { method: 'PATCH', token: superToken, body: { role: 'admin' } })).status, 200);
  assert.strictEqual((await pool.query('SELECT is_super_admin FROM users WHERE id = $1', [stu.id])).rows[0].is_super_admin, false, 'new admins are never super by default');
});

test('role change and scope: becoming faculty starts with own department; leaving faculty drops scope', async () => {
  const stu = await makeUser({ role: 'student', department: 'Information Technology' });
  assert.strictEqual((await api(`/admin/users/${stu.id}/role`, { method: 'PATCH', token: adminToken, body: { role: 'faculty' } })).status, 200);
  const sc = await pool.query('SELECT department FROM faculty_scopes WHERE faculty_id = $1', [stu.id]);
  assert.deepStrictEqual(sc.rows.map((r) => r.department), ['Information Technology']);
  assert.strictEqual((await api(`/admin/users/${stu.id}/role`, { method: 'PATCH', token: adminToken, body: { role: 'student' } })).status, 200);
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM faculty_scopes WHERE faculty_id = $1', [stu.id])).rows[0].n, 0);

  const nodept = await makeUser({ role: 'student', department: null });
  await api(`/admin/users/${nodept.id}/role`, { method: 'PATCH', token: adminToken, body: { role: 'faculty' } });
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM faculty_scopes WHERE faculty_id = $1', [nodept.id])).rows[0].n, 0, 'no department => no access until an admin grants it');
});

test('invariant: after every Super Admin operation above, at least one active Super Admin remains', async () => {
  const n = (await pool.query(`SELECT COUNT(*)::int n FROM users WHERE role='admin' AND is_super_admin AND status='ACTIVE'`)).rows[0].n;
  assert.ok(n >= 1);
  assert.strictEqual((await api(`/admin/users/${superId}/status`, { method: 'PATCH', token: superToken, body: { status: 'SUSPENDED' } })).status, 400, 'cannot suspend yourself');
  // DB-level guard: is_super_admin on a non-admin is impossible.
  await assert.rejects(pool.query(`UPDATE users SET is_super_admin = TRUE WHERE id = (SELECT id FROM users WHERE role = 'student' LIMIT 1)`), /users_super_admin_is_admin/);
});

// ---------------------------------------------------------------- CLI, seed guard, secrecy
const run = (script, args, env = {}) =>
  spawnSync('node', [path.join(__dirname, '..', 'scripts', script), ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('create-admin CLI: refuses when a Super Admin exists, --force creates an INVITED Super Admin with a one-time link, never hijacks other accounts', async () => {
  const email = `${uniq()}@college.test`;
  const refused = run('create-admin.js', ['--email', email, '--name', 'CLI Admin']);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /already exists/);

  const ok = run('create-admin.js', ['--email', email, '--name', 'CLI Admin', '--force']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  const link = ok.stdout.match(/https?:\/\/\S+#token=(\S+)/);
  assert.ok(link, ok.stdout);
  const u = (await pool.query('SELECT id, status, is_super_admin, password_hash FROM users WHERE email = $1', [email])).rows[0];
  assert.strictEqual(u.status, 'INVITED'); assert.strictEqual(u.is_super_admin, true); assert.strictEqual(u.password_hash, null);
  const t = (await pool.query('SELECT token_hash FROM auth_tokens WHERE user_id = $1', [u.id])).rows[0];
  assert.strictEqual(t.token_hash, sha256(link[1]), 'only the hash is stored');
  assert.notStrictEqual(t.token_hash, link[1]);
  const au = (await pool.query(`SELECT actor_id, actor_label FROM admin_audit_log WHERE target_id = $1 AND action = 'SUPER_ADMIN_CREATED'`, [String(u.id)])).rows[0];
  assert.strictEqual(au.actor_id, null); assert.strictEqual(au.actor_label, 'cli:create-admin');
  // the link really activates the account
  assert.strictEqual((await api('/auth/activate', { method: 'POST', body: { token: link[1], password: PASSWORD } })).status, 200);

  const stu = await makeUser({ role: 'student' });
  const hijack = run('create-admin.js', ['--email', stu.email, '--name', 'X Y', '--force', '--promote']);
  assert.strictEqual(hijack.status, 1);
  assert.strictEqual((await pool.query('SELECT role FROM users WHERE id = $1', [stu.id])).rows[0].role, 'student');
  assert.strictEqual(run('create-admin.js', ['--email', 'nope', '--force']).status, 1);
});

test('demo seed refuses to run in production unless explicitly allowed', () => {
  const r = run('seed.js', [], { NODE_ENV: 'production', ALLOW_DEMO_SEED: '' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Refusing to seed demo accounts in production/);
});

test('secrecy: activation tokens never appear in audit details, API listings or server logs', async () => {
  assert.ok(secrets.length >= 2);
  const audit = JSON.stringify((await pool.query('SELECT details, actor_label FROM admin_audit_log ORDER BY id DESC LIMIT 500')).rows);
  const listing = JSON.stringify([(await api('/admin/faculty?limit=100', { token: adminToken })).data, (await api('/admin/administrators', { token: superToken })).data]);
  for (const s of secrets) {
    assert.ok(!audit.includes(s), 'token in audit log');
    assert.ok(!listing.includes(s), 'token in listing');
    assert.ok(!logged.join('\n').includes(s), 'token in logs');
  }
  assert.ok(!listing.includes('password_hash') && !listing.includes('token_hash'));
});
