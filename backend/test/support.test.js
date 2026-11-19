// Phase 11 tests: support tickets - validation, ownership, hidden admin notes, admin management, rate limit, notifications.
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
const P = `p11${Date.now()}`;
const MARK = `Mark${Date.now()}`; // goes in subjects so searches match only this run's tickets
let server; let base; let seq = 0; let admin;

async function send(p, { method = 'GET', token, json } = {}) {
  const init = { method, headers: token ? { Authorization: `Bearer ${token}` } : {} };
  if (json) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
  const res = await fetch(base + p, init);
  let data = {}; try { data = JSON.parse(await res.text()); } catch { /* none */ }
  return { status: res.status, data };
}
async function makeUser(role) {
  const n = `${P}x${++seq}`; const email = `${n}@college.test`;
  const id = (await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active,department,employee_id,enrollment_no)
     VALUES ($1,$2,$3,$4,'ACTIVE',TRUE,'Computer Science & Engineering',$5,$6) RETURNING id`,
    [`User ${n}`, email, await bcrypt.hash(PASSWORD, 4), role, role === 'faculty' ? n.toUpperCase() : null, role === 'student' ? n.toUpperCase() : null])).rows[0].id;
  const token = (await send('/auth/login', { method: 'POST', json: { email, password: PASSWORD } })).data.token;
  return { id, email, token, name: `User ${n}` };
}
const body = (u, over = {}) => ({ name: u.name, email: u.email, category: 'LOGIN', subject: 'Cannot sign in', message: 'The sign in page says my password is wrong.', ...over });
const create = (u, over) => send('/support/tickets', { method: 'POST', token: u.token, json: body(u, over) });
const adminList = (qs = '') => send(`/admin/support/tickets${qs}`, { token: admin.token });

test.before(async () => {
  await initSchema();
  await new Promise((r) => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  admin = await makeUser('admin');
});
test.beforeEach(() => rateLimit.resetAll());
test.after(async () => {
  const ids = (await pool.query(`SELECT id FROM users WHERE email LIKE $1`, [`${P}%`])).rows.map((r) => r.id);
  await pool.query('DELETE FROM support_tickets WHERE user_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('a signed-in user files a ticket: unique id, linked to them, stored in PostgreSQL', async () => {
  const s = await makeUser('student'); const f = await makeUser('faculty');
  const a = await create(s); const b = await create(s, { subject: 'Second problem' }); const c = await create(f, { category: 'VERIFICATION' });
  assert.strictEqual(a.status, 201, JSON.stringify(a.data));
  assert.match(a.data.ticket_ref, /^SUP-\d{6}$/);
  assert.strictEqual(a.data.status, 'OPEN');
  assert.strictEqual(a.data.category_label, 'Login Problems');
  assert.strictEqual(new Set([a.data.ticket_ref, b.data.ticket_ref, c.data.ticket_ref]).size, 3);
  const row = (await pool.query('SELECT user_id, email, status FROM support_tickets WHERE ticket_ref = $1', [a.data.ticket_ref])).rows[0];
  assert.strictEqual(row.user_id, s.id);
  assert.strictEqual(row.email, s.email);
  assert.strictEqual((await send('/support/tickets', { method: 'POST', json: body(s) })).status, 401, 'signing in is required');
  assert.ok(!('admin_notes' in a.data) && !('user_id' in a.data));
});

test('validation: every field is checked and the email must be the registered one', async () => {
  const s = await makeUser('student');
  const bad = [
    { name: 'A' }, { name: '' }, { email: 'not-an-email' }, { email: 'someone.else@college.test' },
    { category: 'MADE_UP' }, { category: '' }, { subject: 'abc' }, { subject: 'x'.repeat(121) },
    { message: 'too short' }, { message: 'y'.repeat(2001) }, { message: '   \u0000   ' },
  ];
  for (const over of bad) assert.strictEqual((await create(s, over)).status, 400, JSON.stringify(over).slice(0, 60));
  const r = await create(s, { name: '  Asha   Rao ', email: s.email.toUpperCase(), subject: '  Spaced   out  ' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.name, 'Asha Rao');
  assert.strictEqual(r.data.subject, 'Spaced out');
  const e = await create(s, { email: 'other@college.test', subject: 'Email mismatch' });
  assert.ok(e.data.fields.email, 'the error names the field');
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM support_tickets WHERE user_id = $1`, [s.id])).rows[0].n, 1, 'bad requests stored nothing');
  assert.strictEqual((await send('/support/tickets', { method: 'POST', token: s.token, json: { ...body(s), user_id: 1, status: 'RESOLVED', admin_notes: 'x' } })).data.status, 'OPEN', 'client cannot set status');
});

test('users see only their own tickets, never admin notes; others get 404', async () => {
  const a = await makeUser('student'); const b = await makeUser('student');
  const t = (await create(a)).data; await create(b, { subject: 'Belongs to B' });
  await send(`/admin/support/tickets/${t.ticket_ref}`, { method: 'PATCH', token: admin.token, json: { admin_notes: 'INTERNAL: suspect shared password' } });
  const mine = await send('/support/tickets', { token: a.token });
  assert.deepStrictEqual(mine.data.tickets.map((x) => x.ticket_ref), [t.ticket_ref]);
  const one = await send(`/support/tickets/${t.ticket_ref}`, { token: a.token });
  assert.strictEqual(one.status, 200);
  assert.ok(!JSON.stringify([mine.data, one.data]).includes('INTERNAL') && !('admin_notes' in one.data), 'internal notes never reach the user');
  assert.strictEqual((await send(`/support/tickets/${t.ticket_ref}`, { token: b.token })).status, 404);
  assert.strictEqual((await send('/support/tickets/not-a-ref', { token: a.token })).status, 400);
  assert.strictEqual((await send('/support/tickets?status=BOGUS', { token: a.token })).status, 400);
  const paged = await send('/support/tickets?limit=1&page=1', { token: a.token });
  assert.strictEqual(paged.data.limit, 1);
});

test('admin routes are admin-only', async () => {
  const s = await makeUser('student'); const f = await makeUser('faculty');
  const t = (await create(s)).data;
  for (const u of [s, f]) {
    assert.strictEqual((await send('/admin/support/tickets', { token: u.token })).status, 403);
    assert.strictEqual((await send(`/admin/support/tickets/${t.ticket_ref}`, { token: u.token })).status, 403);
    assert.strictEqual((await send(`/admin/support/tickets/${t.ticket_ref}`, { method: 'PATCH', token: u.token, json: { status: 'RESOLVED' } })).status, 403);
  }
  assert.strictEqual((await send('/admin/support/tickets')).status, 401);
  assert.strictEqual((await pool.query('SELECT status FROM support_tickets WHERE ticket_ref = $1', [t.ticket_ref])).rows[0].status, 'OPEN');
});

test('admin search and filters: by ticket id, status and category', async () => {
  const s = await makeUser('student');
  const t1 = (await create(s, { category: 'TECHNICAL', subject: `Findable ${MARK}` })).data;
  const t2 = (await create(s, { category: 'OTHER', subject: `Other thing ${MARK}` })).data;
  await send(`/admin/support/tickets/${t2.ticket_ref}`, { method: 'PATCH', token: admin.token, json: { status: 'IN_PROGRESS' } });
  const refs = (r) => r.data.tickets.map((t) => t.ticket_ref);
  assert.deepStrictEqual(refs(await adminList(`?search=${t1.ticket_ref}`)), [t1.ticket_ref]);
  assert.deepStrictEqual(refs(await adminList(`?search=${t1.ticket_ref.toLowerCase()}`)), [t1.ticket_ref], 'id search ignores case');
  assert.deepStrictEqual(refs(await adminList(`?search=${MARK}&category=TECHNICAL`)), [t1.ticket_ref]);
  assert.deepStrictEqual(refs(await adminList(`?search=${MARK}&status=IN_PROGRESS`)), [t2.ticket_ref]);
  assert.deepStrictEqual(refs(await adminList(`?search=${MARK}&status=OPEN&category=OTHER`)), []);
  assert.deepStrictEqual(refs(await adminList('?search=%25')), [], 'a % in the search is literal, not a wildcard');
  assert.strictEqual((await adminList('?status=BAD')).status, 400);
  assert.strictEqual((await adminList('?category=BAD')).status, 400);
  const all = (await adminList(`?search=${MARK}`)).data;
  assert.strictEqual(all.total, 2);
  assert.ok(all.counts.OPEN >= 1 && 'RESOLVED' in all.counts);
});

test('admin updates status and notes: resolved time, audit entry, owner notified without the notes', async () => {
  const s = await makeUser('student');
  const t = (await create(s)).data;
  const url = `/admin/support/tickets/${t.ticket_ref}`;
  assert.strictEqual((await send(url, { method: 'PATCH', token: admin.token, json: { status: 'DONE' } })).status, 400);
  assert.strictEqual((await send(url, { method: 'PATCH', token: admin.token, json: {} })).status, 400);
  assert.strictEqual((await send(url, { method: 'PATCH', token: admin.token, json: { admin_notes: 'z'.repeat(2001) } })).status, 400);
  assert.strictEqual((await send('/admin/support/tickets/SUP-999999', { method: 'PATCH', token: admin.token, json: { status: 'RESOLVED' } })).status, 404);
  const r1 = await send(url, { method: 'PATCH', token: admin.token, json: { status: 'RESOLVED', admin_notes: 'Reset the password by hand.' } });
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.data));
  assert.strictEqual(r1.data.status, 'RESOLVED'); assert.ok(r1.data.resolved_at);
  assert.strictEqual(r1.data.admin_notes, 'Reset the password by hand.');
  assert.strictEqual((await send(url, { token: admin.token })).data.admin_notes, 'Reset the password by hand.');
  const r2 = await send(url, { method: 'PATCH', token: admin.token, json: { status: 'OPEN' } });
  assert.strictEqual(r2.data.resolved_at, null, 'reopening clears the resolved time');
  assert.strictEqual(r2.data.admin_notes, 'Reset the password by hand.', 'a status-only update keeps the notes');
  const n = (await pool.query(`SELECT title, message, link FROM notifications WHERE user_id = $1 ORDER BY id`, [s.id])).rows;
  assert.deepStrictEqual(n.map((x) => x.message), [`Your ticket ${t.ticket_ref} is resolved.`, `Your ticket ${t.ticket_ref} is reopened.`]);
  assert.ok(n.every((x) => x.link === '/support' && !x.message.includes('password')));
  const audit = (await pool.query(`SELECT details FROM admin_audit_log WHERE action = 'SUPPORT_TICKET_UPDATED' AND target_id = $1 ORDER BY id`, [t.ticket_ref])).rows;
  assert.strictEqual(audit.length, 2);
  assert.ok(!JSON.stringify(audit).includes('by hand'), 'the audit log keeps no note text');
  await send(url, { method: 'PATCH', token: admin.token, json: { status: 'OPEN' } });
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM notifications WHERE user_id = $1`, [s.id])).rows[0].n, 2, 'a no-change update notifies nobody');
});

test('new tickets notify admins in-app; email is never claimed', async () => {
  const s = await makeUser('student');
  const before = (await pool.query('SELECT COUNT(*)::int n FROM notifications WHERE user_id = $1', [admin.id])).rows[0].n;
  const t = (await create(s)).data;
  const after = (await pool.query(`SELECT message, link FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [admin.id])).rows[0];
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM notifications WHERE user_id = $1', [admin.id])).rows[0].n, before + 1);
  assert.ok(after.message.includes(t.ticket_ref)); assert.strictEqual(after.link, '/admin?tab=support');
  assert.ok(!JSON.stringify(t).toLowerCase().includes('email sent'));
});

test('rate limit: 5 tickets an hour per user, and one user cannot block another', async () => {
  const a = await makeUser('student'); const b = await makeUser('student');
  for (let i = 0; i < 5; i++) assert.strictEqual((await create(a, { subject: `Ticket number ${i}` })).status, 201);
  const blocked = await create(a, { subject: 'One too many' });
  assert.strictEqual(blocked.status, 429); assert.strictEqual(blocked.data.code, 'RATE_LIMITED');
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM support_tickets WHERE user_id = $1', [a.id])).rows[0].n, 5);
  assert.strictEqual((await create(b)).status, 201);
});

test('tickets survive deleting the account (user link becomes empty); the database rejects bad values', async () => {
  const s = await makeUser('student'); const t = (await create(s)).data;
  await assert.rejects(pool.query(`UPDATE support_tickets SET status = 'CLOSED' WHERE ticket_ref = $1`, [t.ticket_ref]));
  await assert.rejects(pool.query(`UPDATE support_tickets SET category = 'X' WHERE ticket_ref = $1`, [t.ticket_ref]));
  await pool.query('DELETE FROM users WHERE id = $1', [s.id]);
  const row = (await pool.query('SELECT user_id FROM support_tickets WHERE ticket_ref = $1', [t.ticket_ref])).rows[0];
  assert.strictEqual(row.user_id, null);
  await pool.query('DELETE FROM support_tickets WHERE ticket_ref = $1', [t.ticket_ref]);
});
