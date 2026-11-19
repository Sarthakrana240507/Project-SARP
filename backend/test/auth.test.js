// Phase 2 tests: migrations, DB-backed authentication, rate limiting, profile restrictions.
// Run with: npm run test:auth   (needs DATABASE_URL and JWT_SECRET)
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');
const app = require('../src/server');
const { initSchema } = require('../src/models/schema');

const PASSWORD = 'TestPass@12345';
const stamp = Date.now();
let server;
let base;
const made = [];

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => ({})) };
}

async function makeUser(label, { role = 'student', status = 'ACTIVE', department = 'CSE' } = {}) {
  const email = `p2.${label}.${stamp}@sarp.local`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, department, status, is_active, enrollment_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [`P2 ${label}`, email, hash, role, department, status, status === 'ACTIVE', `P2-${label}-${stamp}`]
  );
  made.push(r.rows[0].id);
  return { id: r.rows[0].id, email };
}
const login = (email, password = PASSWORD) => api('/auth/login', { method: 'POST', body: { email, password } });

test.before(async () => {
  await initSchema();
  await new Promise((resolve) => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.after(async () => {
  if (made.length) {
    await pool.query('DELETE FROM notifications WHERE user_id = ANY($1)', [made]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made]);
  }
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('migrations are recorded and re-running them is a no-op', async () => {
  await initSchema();
  await initSchema();
  const names = (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.deepStrictEqual(names.slice(0, 3), ['001_baseline', '002_user_status', '003_onboarding']);
  const col = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='status'`);
  assert.strictEqual(col.rows.length, 1);
});

test('status column rejects values outside INVITED/ACTIVE/SUSPENDED', async () => {
  const u = await makeUser('chk');
  await assert.rejects(pool.query(`UPDATE users SET status='ADMIN' WHERE id=$1`, [u.id]), /users_status_check/);
});

test('login succeeds for an ACTIVE user and returns status, never the password hash', async () => {
  const u = await makeUser('ok');
  const r = await login(u.email);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.user.status, 'ACTIVE');
  assert.ok(r.data.token);
  assert.ok(!JSON.stringify(r.data).includes('password_hash'));
  const claims = jwt.decode(r.data.token);
  assert.ok(claims.exp - claims.iat <= 12 * 3600, 'default token lifetime should be 12h or less');
});

test('wrong password and unknown email give the same 401 message', async () => {
  const u = await makeUser('bad');
  const a = await login(u.email, 'WrongPassword1');
  const b = await login(`nobody.${stamp}@sarp.local`);
  assert.strictEqual(a.status, 401);
  assert.strictEqual(b.status, 401);
  assert.strictEqual(a.data.error, b.data.error);
});

test('SUSPENDED and INVITED users cannot log in; status is hidden until password is right', async () => {
  const s = await makeUser('susp', { status: 'SUSPENDED' });
  const i = await makeUser('inv', { status: 'INVITED' });
  const s1 = await login(s.email);
  assert.strictEqual(s1.status, 403);
  assert.strictEqual(s1.data.code, 'ACCOUNT_SUSPENDED');
  const i1 = await login(i.email);
  assert.strictEqual(i1.status, 403);
  assert.strictEqual(i1.data.code, 'ACCOUNT_NOT_ACTIVE');
  const wrong = await login(s.email, 'WrongPassword1');
  assert.strictEqual(wrong.status, 401, 'wrong password must not reveal that the account is suspended');
});

test('suspending a user kills their EXISTING token immediately', async () => {
  const admin = await makeUser('adm', { role: 'admin' });
  const stu = await makeUser('live');
  const adminToken = (await login(admin.email)).data.token;
  const stuToken = (await login(stu.email)).data.token;
  assert.strictEqual((await api('/auth/me', { token: stuToken })).status, 200);

  const sus = await api(`/admin/users/${stu.id}/status`, { method: 'PATCH', token: adminToken, body: { status: 'SUSPENDED' } });
  assert.strictEqual(sus.status, 200);
  const after = await api('/auth/me', { token: stuToken });
  assert.strictEqual(after.status, 403);
  assert.strictEqual(after.data.code, 'ACCOUNT_SUSPENDED');

  const back = await api(`/admin/users/${stu.id}/status`, { method: 'PATCH', token: adminToken, body: { is_active: true } });
  assert.strictEqual(back.status, 200);
  assert.strictEqual((await api('/auth/me', { token: stuToken })).status, 200);
});

test('admin cannot "activate" an INVITED account (it has no password yet)', async () => {
  const admin = await makeUser('adm2', { role: 'admin' });
  const inv = await makeUser('inv2', { status: 'INVITED' });
  const adminToken = (await login(admin.email)).data.token;
  const r = await api(`/admin/users/${inv.id}/status`, { method: 'PATCH', token: adminToken, body: { status: 'ACTIVE' } });
  assert.strictEqual(r.status, 409);
});

test('role comes from the database: a forged "admin" claim does not grant admin access', async () => {
  const stu = await makeUser('forge');
  const forged = jwt.sign({ id: stu.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const r = await api('/admin/overview', { token: forged });
  assert.strictEqual(r.status, 403);
});

test('tampered, wrong-secret, alg=none and malformed tokens are rejected with 401', async () => {
  const stu = await makeUser('tok');
  const wrongSecret = jwt.sign({ id: stu.id, role: 'student' }, 'some-other-secret-value-xxxxxxxxxxxx');
  assert.strictEqual((await api('/auth/me', { token: wrongSecret })).status, 401);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const algNone = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: stu.id, role: 'admin' })}.`;
  assert.strictEqual((await api('/auth/me', { token: algNone })).status, 401);
  assert.strictEqual((await api('/auth/me', { token: 'not.a.jwt' })).status, 401);
  assert.strictEqual((await api('/auth/me')).status, 401);
});

test('token for a deleted account is rejected', async () => {
  const u = await makeUser('gone');
  const t = (await login(u.email)).data.token;
  await pool.query('DELETE FROM users WHERE id=$1', [u.id]);
  assert.strictEqual((await api('/auth/me', { token: t })).status, 401);
});

test('profile: student can change name but NOT department, student ID, role or status', async () => {
  const u = await makeUser('prof', { department: 'CSE' });
  const t = (await login(u.email)).data.token;

  const ok = await api('/auth/profile', { method: 'PUT', token: t, body: { name: 'New Name' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.user.name, 'New Name');

  for (const body of [{ department: 'ECE' }, { enrollment_no: 'HACKED-1' }, { role: 'admin' }, { status: 'ACTIVE', academic_year: '2099' }, { is_active: false }]) {
    const r = await api('/auth/profile', { method: 'PUT', token: t, body });
    assert.strictEqual(r.status, 403, `should reject ${JSON.stringify(body)}`);
  }
  const row = (await pool.query('SELECT role, department, enrollment_no, status FROM users WHERE id=$1', [u.id])).rows[0];
  assert.deepStrictEqual(row, { role: 'student', department: 'CSE', enrollment_no: `P2-prof-${stamp}`, status: 'ACTIVE' });
});

test('profile: re-sending the unchanged values (what a form does) is accepted and wipes nothing', async () => {
  const u = await makeUser('same', { department: 'IT' });
  const t = (await login(u.email)).data.token;
  const me = (await api('/auth/me', { token: t })).data.user;
  const r = await api('/auth/profile', { method: 'PUT', token: t, body: { name: me.name, department: me.department, enrollment_no: me.enrollment_no } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.user.department, 'IT');
  assert.strictEqual(r.data.user.enrollment_no, `P2-same-${stamp}`);
});

test('profile: empty name rejected', async () => {
  const u = await makeUser('empty');
  const t = (await login(u.email)).data.token;
  assert.strictEqual((await api('/auth/profile', { method: 'PUT', token: t, body: { name: '   ' } })).status, 400);
});

test('change-password works with the snake_case payload the frontend sends, and invalidates older sessions', async () => {
  const u = await makeUser('pw');
  const oldToken = (await login(u.email)).data.token;
  await new Promise((r) => setTimeout(r, 1100)); // iat has 1-second resolution

  const wrong = await api('/auth/change-password', { method: 'PUT', token: oldToken, body: { current_password: 'nope', new_password: 'BrandNew@9876' } });
  assert.strictEqual(wrong.status, 400);
  const same = await api('/auth/change-password', { method: 'PUT', token: oldToken, body: { current_password: PASSWORD, new_password: PASSWORD } });
  assert.strictEqual(same.status, 400);

  const ok = await api('/auth/change-password', { method: 'PUT', token: oldToken, body: { current_password: PASSWORD, new_password: 'BrandNew@9876' } });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.data.token);

  assert.strictEqual((await api('/auth/me', { token: oldToken })).status, 401, 'old session must be revoked');
  assert.strictEqual((await api('/auth/me', { token: ok.data.token })).status, 200, 'returned token keeps this session alive');
  assert.strictEqual((await login(u.email, PASSWORD)).status, 401);
  assert.strictEqual((await login(u.email, 'BrandNew@9876')).status, 200);
});

test('login is rate limited per email+IP: 429 with Retry-After, other emails unaffected', async () => {
  const victim = await makeUser('rl');
  const other = await makeUser('rl2');
  let last;
  for (let i = 0; i < 10; i++) last = await login(victim.email, 'WrongPassword1');
  assert.strictEqual(last.status, 401, 'first 10 attempts are processed normally');
  const blocked = await login(victim.email, PASSWORD); // even the CORRECT password is blocked now
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.data.code, 'RATE_LIMITED');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.strictEqual((await login(other.email)).status, 200);
});

test('malformed JSON body returns 400, not 500', async () => {
  const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
  assert.strictEqual(res.status, 400);
});

test('startup config check rejects missing JWT_SECRET', () => {
  const { checkEnv } = require('../src/config/env');
  const saved = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  assert.throws(checkEnv, /JWT_SECRET is not set/);
  process.env.JWT_SECRET = saved;
});
