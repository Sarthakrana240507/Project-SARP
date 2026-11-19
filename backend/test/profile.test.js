// Phase 9 tests: profile photo upload/replace/remove, validation, privacy, restricted profile fields.
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
const P = `p9${Date.now()}`;
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



const AV = path.resolve(__dirname, '../uploads/avatars');
const avatarFiles = () => new Set(fs.readdirSync(AV));
const photoRow = async (u) => (await pool.query('SELECT profile_image_path p, profile_image_mime m, profile_image_updated_at t FROM users WHERE id = $1', [u.id])).rows[0];
const putPhoto = (u, f, field = 'photo') => {
  const fd = new FormData();
  if (f) fd.append(field, new Blob([f.buf], { type: f.type }), f.name);
  return fetch(`${base}/auth/profile/photo`, { method: 'PUT', headers: u ? { Authorization: `Bearer ${u.token}` } : {}, body: fd })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
};
const getPhoto = (u) => send('/auth/profile/photo', { token: u?.token });
const delPhoto = (u) => send('/auth/profile/photo', { method: 'DELETE', token: u?.token });
const gif = () => ({ buf: Buffer.concat([Buffer.from('GIF89a'), rnd()]), name: 'a.gif', type: 'image/gif' });
const svg = () => ({ buf: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), name: 'a.svg', type: 'image/svg+xml' });

test('upload: JPG, JPEG, PNG and WEBP are accepted; only a file reference is stored; the path is never exposed', async () => {
  for (const [make, ext] of [[jpg, 'photo.jpg'], [jpg, 'photo.jpeg'], [png, 'me.png'], [webp, 'me.webp']]) {
    const u = await makeUser({ role: 'student' });
    const f = { ...make(), name: ext };
    const r = await putPhoto(u, f);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.has_photo, true); assert.ok(r.data.photo_version);
    const row = await photoRow(u);
    assert.ok(row.p.startsWith(AV + path.sep), 'stored inside uploads/avatars'); assert.ok(fs.existsSync(row.p));
    assert.ok(!path.basename(row.p).includes('photo') && !path.basename(row.p).includes('me.'), 'stored under a random name, not the client file name');
    const col = (await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name='users' AND column_name='profile_image_path'`)).rows[0];
    assert.strictEqual(col.data_type, 'text', 'a reference, not binary data');
    const me = (await send('/auth/me', { token: u.token })).data.user;
    assert.strictEqual(me.has_photo, true); assert.strictEqual(me.photo_version, r.data.photo_version);
    const login = (await send('/auth/login', { method: 'POST', json: { email: u.email, password: PASSWORD } })).data;
    assert.strictEqual(login.user.has_photo, true);
    for (const body of [JSON.stringify(me), JSON.stringify(login.user), JSON.stringify(r.data)]) {
      assert.ok(!/profile_image|uploads|avatars|\.jpg|\.png|\.webp/i.test(body.replace(/photo_version|has_photo/g, '')), 'no file path leaks: ' + body);
    }
    const got = await getPhoto(u);
    assert.strictEqual(got.status, 200); assert.strictEqual(got.headers.get('content-type'), row.m);
    assert.strictEqual(got.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(got.buf.equals(fs.readFileSync(row.p)), 'serves exactly the stored image');
  }
  // admin user list never carries it either
  const list = JSON.stringify((await send('/admin/users', { token: adminToken })).data);
  assert.ok(!/profile_image|avatars/i.test(list));
});

test('validation: wrong content, wrong type, too large, wrong field, none - all refused and nothing is left on disk', async () => {
  const u = await makeUser({ role: 'student' });
  const before = avatarFiles();
  const cases = [
    ['a PDF renamed .jpg', { ...pdf(), name: 'photo.jpg', type: 'image/jpeg' }, 400],
    ['PNG content named .jpg', { ...png(), name: 'photo.jpg', type: 'image/jpeg' }, 400],
    ['JPEG content named .png', { ...jpg(), name: 'photo.png', type: 'image/png' }, 400],
    ['text renamed .png', { buf: Buffer.from('hello world, not an image'), name: 'x.png', type: 'image/png' }, 400],
    ['PDF as a profile photo', pdf(), 400],
    ['GIF', gif(), 400],
    ['SVG (can carry scripts)', svg(), 400],
    ['double extension', { ...jpg(), name: 'photo.jpg.exe', type: 'image/jpeg' }, 400],
    ['an empty file', { buf: Buffer.alloc(0), name: 'x.jpg', type: 'image/jpeg' }, 400],
    ['over 5 MB', { buf: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5 * 1024 * 1024)]), name: 'big.jpg', type: 'image/jpeg' }, 413],
  ];
  for (const [label, f, status] of cases) {
    const r = await putPhoto(u, f);
    assert.strictEqual(r.status, status, `${label}: ${JSON.stringify(r.data)}`);
    assert.ok(r.data.error, label);
  }
  assert.strictEqual((await putPhoto(u, jpg(), 'proof')).status, 400, 'wrong field name');
  assert.strictEqual((await putPhoto(u, null)).status, 400, 'no file');
  await settle();
  assert.deepStrictEqual([...avatarFiles()].filter((f) => !before.has(f)), [], 'rejected uploads leave no files behind');
  assert.strictEqual((await photoRow(u)).p, null);
  // a photo just under the limit is fine
  const edge = { buf: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5 * 1024 * 1024 - 1024)]), name: 'edge.jpg', type: 'image/jpeg' };
  assert.strictEqual((await putPhoto(u, edge)).status, 200);
});

test('replace and remove: the old file is deleted, the version changes, removing returns to the initials avatar', async () => {
  const u = await makeUser({ role: 'student' });
  assert.strictEqual((await getPhoto(u)).status, 404, 'no photo yet');
  assert.strictEqual((await delPhoto(u)).status, 404, 'nothing to remove');
  const first = await putPhoto(u, jpg()); const row1 = await photoRow(u);
  await new Promise((r) => setTimeout(r, 15));
  const second = await putPhoto(u, png()); const row2 = await photoRow(u);
  assert.strictEqual(second.data.message, 'Profile photo replaced.'); assert.strictEqual(first.data.message, 'Profile photo uploaded.');
  assert.notStrictEqual(row1.p, row2.p); assert.ok(!fs.existsSync(row1.p), 'replaced file is deleted'); assert.ok(fs.existsSync(row2.p));
  assert.strictEqual(row2.m, 'image/png'); assert.ok(second.data.photo_version > first.data.photo_version);
  const rm = await delPhoto(u);
  assert.strictEqual(rm.status, 200); assert.strictEqual(rm.data.has_photo, false);
  assert.ok(!fs.existsSync(row2.p), 'removed file is deleted');
  const row3 = await photoRow(u); assert.strictEqual(row3.p, null); assert.strictEqual(row3.m, null); assert.strictEqual(row3.t, null);
  assert.strictEqual((await send('/auth/me', { token: u.token })).data.user.has_photo, false);
  assert.strictEqual((await getPhoto(u)).status, 404);
});

test('privacy: only the owner can read, replace or remove their photo; there is no way to address another user', async () => {
  const a = await makeUser({ role: 'student' }); const b = await makeUser({ role: 'faculty' }); const adm = await makeUser({ role: 'admin' });
  assert.strictEqual((await putPhoto(a, jpg())).status, 200);
  const rowA = await photoRow(a); const bytesA = fs.readFileSync(rowA.p);
  for (const probe of [() => getPhoto(null), () => delPhoto(null), () => putPhoto(null, jpg())]) assert.strictEqual((await probe()).status, 401);
  assert.strictEqual((await getPhoto(b)).status, 404, 'another user gets their own (empty) photo, never A\'s');
  assert.strictEqual((await getPhoto(adm)).status, 404);
  for (const url of [`/auth/profile/photo/${a.id}`, `/auth/${a.id}/photo`, `/users/${a.id}/photo`, `/auth/profile/photo?user_id=${a.id}`]) {
    const r = await send(url, { token: b.token });
    assert.ok(r.status === 404 || (url.includes('?') && r.status === 404), url + ' ' + r.status);
    assert.ok(!r.buf.equals(bytesA));
  }
  // B acts on their own photo; A is untouched
  assert.strictEqual((await putPhoto(b, png())).status, 200);
  assert.strictEqual((await delPhoto(b)).status, 200);
  assert.ok(fs.existsSync(rowA.p)); assert.ok((await getPhoto(a)).buf.equals(bytesA));
  // body/query tricks cannot redirect an upload to someone else
  const fd = new FormData(); fd.append('photo', new Blob([jpg().buf], { type: 'image/jpeg' }), 'x.jpg'); fd.append('user_id', String(a.id)); fd.append('id', String(a.id));
  await fetch(`${base}/auth/profile/photo?user_id=${a.id}`, { method: 'PUT', headers: { Authorization: `Bearer ${b.token}` }, body: fd });
  assert.strictEqual((await photoRow(a)).p, rowA.p, 'A\'s photo reference did not change');
  assert.ok(fs.existsSync(rowA.p));
  await delPhoto(b);
  // a suspended account is locked out of its photo too
  await pool.query(`UPDATE users SET status='SUSPENDED', is_active=FALSE WHERE id=$1`, [a.id]);
  assert.strictEqual((await getPhoto(a)).status, 403); assert.strictEqual((await putPhoto(a, png())).status, 403);
});

test('a tampered database path outside the avatar folder is never served or deleted', async () => {
  const u = await makeUser({ role: 'student' });
  const outside = path.join(require('os').tmpdir(), `${P}-outside.jpg`);
  fs.writeFileSync(outside, jpg().buf); extraFiles.push(outside);
  await pool.query(`UPDATE users SET profile_image_path=$1, profile_image_mime='image/jpeg', profile_image_updated_at=NOW() WHERE id=$2`, [outside, u.id]);
  assert.strictEqual((await getPhoto(u)).status, 404, 'not served');
  assert.strictEqual((await putPhoto(u, png())).status, 200);
  assert.ok(fs.existsSync(outside), 'replace did not delete a file outside the folder');
  await pool.query(`UPDATE users SET profile_image_path=$1 WHERE id=$2`, [outside, u.id]);
  assert.strictEqual((await delPhoto(u)).status, 200);
  assert.ok(fs.existsSync(outside), 'remove did not delete a file outside the folder');
});

test('profile editing: name only; restricted fields are refused; changes persist across logout and login', async () => {
  const s = await makeUser({ role: 'student' });
  const put = (json, u = s) => send('/auth/profile', { method: 'PUT', token: u.token, json });
  const before = (await send('/auth/me', { token: s.token })).data.user;
  for (const [k, v] of [['role', 'admin'], ['department', 'Mechanical Engineering'], ['enrollment_no', 'HACK1'], ['email', 'x@y.test'], ['status', 'SUSPENDED'], ['is_super_admin', true], ['programme', 'MBA'], ['semester', '8'], ['academic_year', '2020-2021'], ['employee_id', 'E1'], ['designation', 'Dean']]) {
    const r = await put({ name: before.name, [k]: v });
    assert.strictEqual(r.status, 403, `${k}: ${JSON.stringify(r.data)}`);
  }
  const after = (await send('/auth/me', { token: s.token })).data.user;
  for (const k of ['role', 'department', 'enrollment_no', 'email', 'status', 'programme', 'semester', 'academic_year']) assert.strictEqual(after[k], before[k], k);
  // unchanged values are fine; photo columns cannot be set through the profile endpoint
  assert.strictEqual((await put({ name: before.name, role: 'student', department: before.department })).status, 200);
  await put({ name: before.name, profile_image_path: '/etc/passwd', profile_image_mime: 'text/plain' });
  assert.strictEqual((await photoRow(s)).p, null);
  assert.strictEqual((await put({ name: '   ' })).status, 400);
  assert.strictEqual((await put({ name: 'x'.repeat(101) })).status, 400);
  assert.strictEqual((await put({ name: 'A' })).status, 400, 'too short');
  assert.strictEqual((await put({ name: '=HYPERLINK("x")' })).status, 400, 'formula injection');
  const ok = await put({ name: '  Asha  Verma  ' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.user.name, 'Asha Verma', 'spaces are tidied');
  // photo + name survive logout/login
  assert.strictEqual((await putPhoto(s, webp())).status, 200);
  const relog = (await send('/auth/login', { method: 'POST', json: { email: s.email, password: PASSWORD } })).data;
  assert.ok(/^Asha\s+Verma$/.test(relog.user.name)); assert.strictEqual(relog.user.has_photo, true);
  assert.strictEqual((await send('/auth/profile/photo', { token: relog.token })).status, 200);
  // faculty and admin have the same profile and photo features
  for (const role of ['faculty', 'admin']) {
    const u = await makeUser({ role });
    assert.strictEqual((await putPhoto(u, jpg())).status, 200, role);
    assert.strictEqual((await send('/auth/profile', { method: 'PUT', token: u.token, json: { name: `Renamed ${role}` } })).status, 200);
    assert.strictEqual((await send('/auth/profile', { method: 'PUT', token: u.token, json: { role: role === 'admin' ? 'faculty' : 'admin' } })).status, 403);
    assert.strictEqual((await delPhoto(u)).status, 200);
  }
});
