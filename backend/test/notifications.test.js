// Phase 8 tests: in-app notifications - ownership, events, paging, read state, link/type safety, failure isolation.
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
const P = `p8${Date.now()}`;
const UPLOADS = path.resolve(__dirname, '../uploads');
let server; let base; let adminToken; let seq = 0;
const pathsToClean = new Set();

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
  await new Promise((r) => server.close(r));
  await pool.end();
});


const DEPT = `Dept ${P}`; const OTHER_DEPT = `Other ${P}`;
const ids = (r) => r.data.activities.map((a) => a.id);
const sorted = (a) => [...a].sort((x, y) => x - y);

// ------------------------------------------------------------------ queue filters

const get = (p, u, qs = '') => send(p + qs, { token: u.token });
const patch = (p, u, json) => send(p, { method: 'PATCH', token: u.token, json });
const titles = async (u) => (await pool.query('SELECT title FROM notifications WHERE user_id = $1 ORDER BY id', [u.id])).rows.map((r) => r.title);
const decide = (act, fac, id, remarks) => send(`/activities/${id}/${act}`, { method: 'PATCH', token: fac.token, json: { remarks } });
const CSE = 'Computer Science & Engineering';

test('ownership: users only see and change their own notifications; ids are validated', async () => {
  const a = await makeUser({ role: 'student' }); const b = await makeUser({ role: 'student' });
  await pool.query(`INSERT INTO notifications (user_id,title,message) VALUES ($1,'For A','a1'),($1,'For A 2','a2'),($2,'For B','b1')`, [a.id, b.id]);
  const la = (await get('/notifications', a)).data; const lb = (await get('/notifications', b)).data;
  assert.deepStrictEqual(la.notifications.map((n) => n.title).sort(), ['For A', 'For A 2']);
  assert.deepStrictEqual(lb.notifications.map((n) => n.title), ['For B']);
  assert.strictEqual(la.unread_count, 2); assert.strictEqual(lb.unread_count, 1);
  assert.ok(la.notifications.every((n) => !('user_id' in n)), 'user_id is not exposed');
  const bId = lb.notifications[0].id;
  assert.strictEqual((await patch(`/notifications/${bId}/read`, a)).status, 404, 'cannot touch another user\'s notification');
  assert.strictEqual((await get('/notifications', b)).data.unread_count, 1);
  for (const bad of ['abc', '1.5', '-1', '99999999999', '1;DROP']) assert.strictEqual((await patch(`/notifications/${encodeURIComponent(bad)}/read`, a)).status, 400, bad);
  assert.strictEqual((await patch('/notifications/999999999/read', a)).status, 404);
  assert.strictEqual((await send('/notifications')).status, 401);
  assert.strictEqual((await send('/notifications/unread-count')).status, 401);
  assert.strictEqual((await send('/notifications/read-all', { method: 'PATCH' })).status, 401);
  // read-all touches only the caller
  const r = await patch('/notifications/read-all', a);
  assert.strictEqual(r.data.updated, 2);
  assert.strictEqual((await get('/notifications/unread-count', a)).data.unread_count, 0);
  assert.strictEqual((await get('/notifications/unread-count', b)).data.unread_count, 1);
});

test('read state: marking read is idempotent and keeps the first read time; filters and paging work', async () => {
  const u = await makeUser({ role: 'student' });
  for (let i = 1; i <= 7; i++) await pool.query(`INSERT INTO notifications (user_id,title,message,created_at) VALUES ($1,$2,'m', NOW() - ($3 || ' minutes')::interval)`, [u.id, `N${i}`, String(i)]);
  const p1 = (await get('/notifications', u, '?limit=3')).data;
  assert.deepStrictEqual(p1.notifications.map((n) => n.title), ['N1', 'N2', 'N3'], 'newest first');
  assert.strictEqual(p1.total, 7); assert.strictEqual(p1.pages, 3); assert.strictEqual(p1.unread_count, 7);
  assert.deepStrictEqual((await get('/notifications', u, '?limit=3&page=3')).data.notifications.map((n) => n.title), ['N7']);
  assert.strictEqual((await get('/notifications', u, '?filter=bogus')).status, 400);
  const first = await patch(`/notifications/${p1.notifications[0].id}/read`, u);
  assert.strictEqual(first.data.is_read, true); assert.ok(first.data.read_at);
  await new Promise((r) => setTimeout(r, 30));
  const again = await patch(`/notifications/${p1.notifications[0].id}/read`, u);
  assert.strictEqual(again.status, 200); assert.strictEqual(again.data.read_at, first.data.read_at, 'read time is not overwritten');
  const unread = (await get('/notifications', u, '?filter=unread&limit=50')).data;
  assert.strictEqual(unread.total, 6); assert.ok(unread.notifications.every((n) => !n.is_read)); assert.strictEqual(unread.unread_count, 6);
  assert.strictEqual((await get('/notifications', u, '?limit=0')).data.limit, 20, 'bad limit falls back to the default');
  assert.strictEqual((await get('/notifications', u, '?limit=9999')).data.limit, 50, 'limit is capped');
});

test('events: submission, decisions, correction and resubmission each notify the right people with working links', async () => {
  const stu = await makeUser({ role: 'student' });
  const inScope = await makeUser({ role: 'faculty', scope: { all: false, departments: [CSE] } });
  const allScope = await makeUser({ role: 'faculty', scope: { all: true, departments: [] } });
  const outScope = await makeUser({ role: 'faculty', scope: { all: false, departments: ['Mechanical Engineering'] } });
  const noScope = await makeUser({ role: 'faculty', scope: { all: false, departments: [] } });
  const suspended = await makeUser({ role: 'faculty', scope: { all: true, departments: [] } });
  await pool.query(`UPDATE users SET status='SUSPENDED', is_active=FALSE WHERE id=$1`, [suspended.id]);

  const act = await submit(stu, { title: 'Notify Me' });
  assert.ok((await titles(stu)).includes('Activity Submitted'));
  for (const f of [inScope, allScope]) assert.ok((await titles(f)).includes('New Activity to Review'), 'faculty with matching scope is told');
  for (const f of [outScope, noScope, suspended]) assert.ok(!(await titles(f)).includes('New Activity to Review'), 'out-of-scope or suspended faculty is not');
  const fn = (await get('/notifications', inScope)).data.notifications.find((n) => n.title === 'New Activity to Review');
  assert.strictEqual(fn.link, `/activity/${act.id}`);
  assert.strictEqual((await get(fn.link.replace('/activity', '/activities'), inScope)).status, 200, 'the linked record opens for that faculty member');
  assert.strictEqual((await get(fn.link.replace('/activity', '/activities'), outScope)).status === 200, false);

  // approval / rejection / correction
  assert.strictEqual((await decide('request-correction', inScope, act.id, 'Please attach a clearer certificate')).status, 200);
  const warn = (await get('/notifications', stu)).data.notifications.find((n) => n.title === 'Correction Requested');
  assert.strictEqual(warn.type, 'warning'); assert.strictEqual(warn.link, `/activity/${act.id}`); assert.match(warn.message, /clearer certificate/);

  const re = await send(`/activities/${act.id}/resubmit`, { method: 'PUT', token: stu.token, fields: { ...good({ title: 'Notify Me' }), expected_version: String(act.version) }, file: pdf() });
  pathsToClean.add(await filePathOf(act.id));
  assert.strictEqual(re.status, 200, JSON.stringify(re.data));
  assert.ok((await titles(stu)).includes('Activity Resubmitted'));
  assert.ok((await titles(inScope)).includes('Activity Resubmitted'), 'previous reviewer / scoped faculty told');
  assert.strictEqual((await titles(inScope)).filter((t) => t === 'Activity Resubmitted').length, 1, 'no duplicate notice for someone who is both reviewer and in scope');
  assert.ok(!(await titles(outScope)).includes('Activity Resubmitted'));

  assert.strictEqual((await decide('approve', inScope, act.id, '')).status, 200);
  const ok = (await get('/notifications', stu)).data.notifications.find((n) => n.title.startsWith('Activity Approved'));
  assert.strictEqual(ok.type, 'success');

  const act2 = await submit(stu, { title: 'Reject Me' });
  assert.strictEqual((await decide('reject', allScope, act2.id, 'Not a valid event')).status, 200);
  const bad = (await get('/notifications', stu)).data.notifications.find((n) => n.title === 'Activity Rejected');
  assert.strictEqual(bad.type, 'error'); assert.match(bad.message, /Not a valid event/);
  // another student never sees any of it
  const other = await makeUser({ role: 'student' });
  assert.deepStrictEqual((await get('/notifications', other)).data.notifications, []);
});

test('drafts are private: saving a draft notifies nobody, submitting it notifies the scoped faculty', async () => {
  const stu = await makeUser({ role: 'student' });
  const fac = await makeUser({ role: 'faculty', scope: { all: false, departments: [CSE] } });
  const d = await send('/activities/draft', { method: 'POST', token: stu.token, fields: good({ title: 'Quiet Draft' }), file: pdf() });
  assert.strictEqual(d.status, 201, JSON.stringify(d.data));
  pathsToClean.add(await filePathOf(d.data.id));
  assert.deepStrictEqual(await titles(stu), []); assert.deepStrictEqual(await titles(fac), []);
  const s = await send(`/activities/${d.data.id}/submit-draft`, { method: 'POST', token: stu.token, fields: {} });
  assert.strictEqual(s.status, 200, JSON.stringify(s.data));
  assert.deepStrictEqual(await titles(stu), ['Activity Submitted']);
  assert.deepStrictEqual(await titles(fac), ['New Activity to Review']);
});

test('helper and database rules: unknown types, external links and a failing insert cannot do harm', async () => {
  const { createNotification, notifyAdmins, safeLink } = require('../src/utils/notifications');
  const u = await makeUser({ role: 'student' });
  assert.strictEqual(safeLink('/activity/5'), '/activity/5');
  for (const l of ['https://evil.test', '//evil.test', 'javascript:alert(1)', 'http://x', 'activity/5', '/a://b', '/' + 'x'.repeat(250), null, 7]) assert.strictEqual(safeLink(l), null, String(l));
  await createNotification(pool, { userId: u.id, title: 'T', message: 'M', type: 'weird', link: 'https://evil.test' });
  await createNotification(pool, { userId: u.id, title: 'x'.repeat(500), message: 'y'.repeat(5000), link: '//evil.test' });
  const rows = (await pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY id', [u.id])).rows;
  assert.strictEqual(rows[0].type, 'info'); assert.strictEqual(rows[0].link, null);
  assert.strictEqual(rows[1].title.length, 150); assert.strictEqual(rows[1].message.length, 1000); assert.strictEqual(rows[1].link, null);
  assert.strictEqual(await createNotification(pool, { userId: u.id, title: '', message: 'm' }), false, 'incomplete notifications are ignored');
  // the database refuses bad rows even if code is bypassed
  await assert.rejects(pool.query(`INSERT INTO notifications (user_id,title,message,link) VALUES ($1,'a','b','https://evil.test')`, [u.id]), /notifications_link_chk/);
  await assert.rejects(pool.query(`INSERT INTO notifications (user_id,title,message,type) VALUES ($1,'a','b','nope')`, [u.id]), /notifications_type_chk/);
  // a failing notification inside a transaction must not poison the transaction
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE users SET name = 'Tx Kept ${P}' WHERE id = $1`, [u.id]);
    assert.strictEqual(await createNotification(c, { userId: 2147483647, title: 'x', message: 'y' }), false, 'FK failure is reported, not thrown');
    assert.strictEqual(await createNotification(c, { userId: u.id, title: 'After failure', message: 'still works' }), true);
    await c.query('COMMIT');
  } finally { c.release(); }
  assert.strictEqual((await pool.query('SELECT name FROM users WHERE id=$1', [u.id])).rows[0].name, `Tx Kept ${P}`);
  assert.ok((await titles(u)).includes('After failure'));
  // admins: only active admins are told
  const adm = await makeUser({ role: 'admin' }); const gone = await makeUser({ role: 'admin' });
  await pool.query(`UPDATE users SET status='SUSPENDED', is_active=FALSE WHERE id=$1`, [gone.id]);
  await notifyAdmins(pool, { title: `Ping ${P}`, message: 'm' });
  assert.ok((await titles(adm)).includes(`Ping ${P}`)); assert.ok(!(await titles(gone)).includes(`Ping ${P}`));
});

test('resubmission also reaches the previous reviewer even if their scope has since changed', async () => {
  const stu = await makeUser({ role: 'student' });
  const rev = await makeUser({ role: 'faculty', scope: { all: false, departments: [CSE] } });
  const act = await submit(stu, { title: 'Scope Moved' });
  assert.strictEqual((await decide('request-correction', rev, act.id, 'Needs a clearer proof')).status, 200);
  await setScope(pool, rev.id, { all: false, departments: ['Mechanical Engineering'] }, null); // no longer covers the student
  const re = await send(`/activities/${act.id}/resubmit`, { method: 'PUT', token: stu.token, fields: { ...good({ title: 'Scope Moved' }), expected_version: String(act.version) }, file: pdf() });
  pathsToClean.add(await filePathOf(act.id));
  assert.strictEqual(re.status, 200, JSON.stringify(re.data));
  assert.ok((await titles(rev)).includes('Activity Resubmitted'), 'the reviewer who asked for the correction is told');
});
