// Phase 13 tests: the sign-in "portal" is a check, never a grant. The role always comes from the database.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');
const app = require('../src/server');
const { initSchema } = require('../src/models/schema');
const { rateLimit } = require('../src/middleware/rateLimit');

const PASSWORD = 'TestPass@12345';
const P = `p13${Date.now()}`;
let server; let base; const users = {};

const login = async (u, portal, password = PASSWORD) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password, ...(portal === undefined ? {} : { portal }) }) });
  return { status: r.status, data: await r.json() };
};
async function make(role, status = 'ACTIVE') {
  const email = `${P}.${role}.${status}@college.test`.toLowerCase();
  const id = (await pool.query(`INSERT INTO users (name,email,password_hash,role,status,is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [`U ${role}`, email, await bcrypt.hash(PASSWORD, 4), role, status, status === 'ACTIVE'])).rows[0].id;
  return { id, email };
}
test.before(async () => {
  await initSchema();
  await new Promise((r) => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  for (const role of ['student', 'faculty', 'admin']) users[role] = await make(role);
  users.suspended = await make('faculty', 'SUSPENDED');
});
test.beforeEach(() => rateLimit.resetAll());
test.after(async () => {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${P}%`]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('each role can use its own portal, and sign-in without a portal still works', async () => {
  for (const role of ['student', 'faculty', 'admin']) {
    const r = await login(users[role], role);
    assert.strictEqual(r.status, 200, role); assert.ok(r.data.token); assert.strictEqual(r.data.user.role, role);
  }
  assert.strictEqual((await login(users.faculty)).status, 200, 'the portal field is optional');
  assert.strictEqual((await login(users.faculty, '')).status, 200, 'an empty portal means none');
});

test('choosing the wrong portal is refused: no token, no role change, no login recorded', async () => {
  const before = (await pool.query('SELECT last_login_at FROM users WHERE id = $1', [users.student.id])).rows[0].last_login_at;
  for (const [role, portal] of [['student', 'faculty'], ['student', 'admin'], ['faculty', 'student'], ['faculty', 'admin'], ['admin', 'student'], ['admin', 'faculty']]) {
    const r = await login(users[role], portal);
    assert.strictEqual(r.status, 403, `${role} on the ${portal} portal`);
    assert.strictEqual(r.data.code, 'PORTAL_MISMATCH');
    assert.ok(!r.data.token && !r.data.user, 'nothing is issued');
  }
  assert.deepStrictEqual((await pool.query('SELECT last_login_at FROM users WHERE id = $1', [users.student.id])).rows[0].last_login_at, before, 'a refused sign-in is not recorded as a login');
});

test('the portal never reveals anything before the password is right', async () => {
  const wrong = await login(users.student, 'faculty', 'WrongPass@1');
  assert.strictEqual(wrong.status, 401); assert.strictEqual(wrong.data.error, 'Invalid email or password');
  const none = await login({ email: `nobody.${P}@college.test` }, 'faculty');
  assert.strictEqual(none.status, 401); assert.strictEqual(none.data.error, wrong.data.error, 'unknown accounts look the same as wrong passwords');
  const susp = await login(users.suspended, 'student');
  assert.strictEqual(susp.data.code, 'ACCOUNT_SUSPENDED', 'account status is reported before any portal check');
});

test('an unknown portal value is a 400, and the token role always comes from the database', async () => {
  for (const bad of ['superadmin', 'ADMIN', 'student;', 'x'.repeat(50), { a: 1 }, ['admin']]) assert.strictEqual((await login(users.student, bad)).status, 400, JSON.stringify(bad));
  const r = await login(users.student, 'student');
  const me = await (await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${r.data.token}` } })).json();
  assert.strictEqual(me.user.role, 'student');
  const adminCall = await fetch(`${base}/admin/users`, { headers: { Authorization: `Bearer ${r.data.token}` } });
  assert.strictEqual(adminCall.status, 403, 'a student session cannot use admin APIs whatever portal was chosen');
});
