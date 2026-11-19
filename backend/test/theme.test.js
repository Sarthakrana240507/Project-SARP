// Phase 10 tests: account theme preference.
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
const P = `p10${Date.now()}`;
const UPLOADS = path.resolve(__dirname, '../uploads');
let server; let base; let adminToken; let seq = 0;
const pathsToClean = new Set();
const extraFiles = [];

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
  for (const r of (await pool.query('SELECT profile_image_path p FROM users WHERE id = ANY($1)', [ids])).rows) if (r.p) fs.rmSync(r.p, { force: true });
  for (const f of extraFiles) fs.rmSync(f, { force: true });
  await pool.query('DELETE FROM activities WHERE student_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  await new Promise((r) => server.close(r));
  await pool.end();
});




const setTheme = (u, theme) => send('/auth/preferences', { method: 'PUT', token: u?.token, json: { theme } });
const stored = async (u) => (await pool.query('SELECT theme_preference t FROM users WHERE id=$1', [u.id])).rows[0].t;

test('theme preference: light, dark and system are saved on the account and returned by /me and login', async () => {
  const u = await makeUser({ role: 'student' });
  assert.strictEqual((await send('/auth/me', { token: u.token })).data.user.theme_preference, null, 'nothing chosen yet');
  for (const t of ['dark', 'light', 'system', 'dark']) {
    const r = await setTheme(u, t);
    assert.strictEqual(r.status, 200, t); assert.deepStrictEqual(r.data, { theme_preference: t });
    assert.strictEqual(await stored(u), t);
    assert.strictEqual((await send('/auth/me', { token: u.token })).data.user.theme_preference, t);
  }
  const login = (await send('/auth/login', { method: 'POST', json: { email: u.email, password: PASSWORD } })).data;
  assert.strictEqual(login.user.theme_preference, 'dark', 'available after signing in on another device');
});

test('theme preference: invalid values and unauthenticated calls are refused; nothing changes', async () => {
  const u = await makeUser({ role: 'faculty' });
  await setTheme(u, 'light');
  for (const bad of ['blue', '', 'DARK', null, undefined, 1, true, ['dark'], { theme: 'dark' }, 'dark; DROP TABLE users', 'x'.repeat(5000)]) {
    assert.strictEqual((await setTheme(u, bad)).status, 400, JSON.stringify(bad)?.slice(0, 30));
  }
  assert.strictEqual(await stored(u), 'light');
  assert.strictEqual((await setTheme(null, 'dark')).status, 401);
  assert.strictEqual((await send('/auth/preferences', { method: 'PUT', token: u.token })).status, 400, 'no body');
  // the database rule rejects anything else even if the route were bypassed
  await assert.rejects(pool.query(`UPDATE users SET theme_preference='purple' WHERE id=$1`, [u.id]), /users_theme_preference_chk/);
});

test('theme preference belongs to the caller only and the profile endpoint cannot be used to set it for others', async () => {
  const a = await makeUser({ role: 'student' }); const b = await makeUser({ role: 'student' }); const adm = await makeUser({ role: 'admin' });
  await setTheme(a, 'dark');
  await send('/auth/preferences', { method: 'PUT', token: b.token, json: { theme: 'light', user_id: a.id, id: a.id } });
  assert.strictEqual(await stored(a), 'dark', 'another user cannot change it'); assert.strictEqual(await stored(b), 'light');
  await send('/auth/profile', { method: 'PUT', token: b.token, json: { name: 'Bee Person', theme_preference: 'dark' } });
  assert.strictEqual(await stored(b), 'light', 'profile edit does not touch it');
  assert.strictEqual((await setTheme(adm, 'system')).status, 200, 'admins too');
  assert.strictEqual(await stored(adm), 'system');
});
