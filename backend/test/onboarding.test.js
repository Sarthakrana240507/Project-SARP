// Phase 3 tests: CSV import, INVITED accounts, activation tokens, verified self-registration,
// password reset, email-delivery honesty, token secrecy, audit log.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');
const app = require('../src/server');
const { initSchema } = require('../src/models/schema');
const { rateLimit } = require('../src/middleware/rateLimit');
const mailer = require('../src/utils/mailer');
const { parseCsv } = require('../src/utils/csv');
const v = require('../src/utils/validation');
const { sha256 } = require('../src/utils/tokens');

const PASSWORD = 'TestPass@12345';
const stamp = Date.now();
const P = `p3${stamp}`; // prefix for every student id / email created here
let server; let base; let adminToken; let adminId;
const secrets = []; // every plaintext token we ever see; none may appear in logs
const logged = [];
const origLog = { log: console.log, error: console.error, warn: console.warn };

async function api(path, { method = 'GET', token, body, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => ({})) };
}
async function upload(csv, { token = adminToken, filename = 'students.csv' } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), filename);
  const res = await fetch(base + '/admin/students/import/preview', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const HEADER = 'student_id,name,email,department,programme,academic_year,semester';
const row = (n, extra = {}) => {
  const r = { id: `${P}-${n}`, name: `Student ${n}`, email: `${P}.${n}@college.test`, dept: 'CSE', prog: 'BTech', year: '2025-26', sem: '3', ...extra };
  return `${r.id},${r.name},${r.email},${r.dept},${r.prog},${r.year},${r.sem}`;
};
const login = (email, password = PASSWORD) => api('/auth/login', { method: 'POST', body: { email, password } });
const tokenOf = (link) => { const t = link.split('#token=')[1]; secrets.push(t); return t; };

async function importAndConfirm(rows) {
  const p = await upload([HEADER, ...rows].join('\n') + '\n');
  assert.strictEqual(p.status, 200, JSON.stringify(p.data));
  const c = await api(`/admin/students/import/${p.data.batch_id}/confirm`, { method: 'POST', token: adminToken, body: {} });
  assert.strictEqual(c.status, 200, JSON.stringify(c.data));
  return { batch: p.data.batch_id, ...c.data };
}
const userByEmail = async (e) => (await pool.query('SELECT * FROM users WHERE email = $1', [e])).rows[0];
async function handoff(userId) {
  const r = await api(`/admin/users/${userId}/activation-link`, { method: 'POST', token: adminToken, body: { delivery: 'HANDOFF' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return tokenOf(r.data.link);
}
// A fully activated student: import -> hand-off link -> activate.
async function activeStudent(n) {
  await importAndConfirm([row(n)]);
  const u = await userByEmail(`${P}.${n}@college.test`);
  const t = await handoff(u.id);
  const a = await api('/auth/activate', { method: 'POST', body: { token: t, password: PASSWORD } });
  assert.strictEqual(a.status, 200);
  return u;
}
function stubTransport() {
  const sent = [];
  return { sent, sendMail: async (m) => { sent.push(m); return { messageId: 'x' }; } };
}

test.before(async () => {
  for (const k of ['log', 'error', 'warn']) console[k] = (...a) => { logged.push(a.map(String).join(' ')); origLog[k](...a); };
  await initSchema();
  await new Promise((r) => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  const hash = await bcrypt.hash(PASSWORD, 4);
  const a = await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active) VALUES ('P3 Admin',$1,$2,'admin','ACTIVE',true) RETURNING id`,
    [`${P}.admin@college.test`, hash]);
  adminId = a.rows[0].id;
  adminToken = (await login(`${P}.admin@college.test`)).data.token;
});
test.beforeEach(() => rateLimit.resetAll());
test.after(async () => {
  Object.assign(console, origLog);
  mailer.setTransportForTests(null);
  await pool.query(`DELETE FROM users WHERE email LIKE $1 OR enrollment_no LIKE $2`, [`${P}%`, `${P}%`]);
  await pool.query(`DELETE FROM import_batches WHERE uploaded_by = $1 OR uploaded_by IS NULL AND filename = 'students.csv'`, [adminId]);
  await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ---------------------------------------------------------------- units
test('CSV parser: quotes, commas in fields, escaped quotes, BOM, CRLF, blank lines, line numbers', () => {
  const { records } = parseCsv('\ufeffa,b\r\n"x, y","he said ""hi"""\r\n\r\nlast,1');
  assert.deepStrictEqual(records.map((r) => r.fields), [['a', 'b'], ['x, y', 'he said "hi"'], ['last', '1']]);
  assert.deepStrictEqual(records.map((r) => r.line), [1, 2, 4]);
  assert.throws(() => parseCsv('a,b\n"unterminated,1'), /Unterminated/);
  assert.throws(() => parseCsv('a,b\nab"c,1'), /Unexpected quote/);
});
test('validators: academic year, password policy, row rules', () => {
  assert.strictEqual(v.normalizeAcademicYear('2025-26'), '2025-2026');
  assert.strictEqual(v.normalizeAcademicYear('2025-2026'), '2025-2026');
  assert.strictEqual(v.normalizeAcademicYear('2025-27'), null);
  assert.strictEqual(v.normalizeAcademicYear('25-26'), null);
  assert.ok(v.passwordProblem('short1'));
  assert.ok(v.passwordProblem('onlyletters'));
  assert.ok(v.passwordProblem('12345678'));
  assert.ok(v.passwordProblem('a'.repeat(73) + '1'));
  assert.strictEqual(v.passwordProblem('GoodPass1'), null);
  assert.ok(v.passwordProblem('Abc12345', { email: 'abc12345' }));
  assert.ok(v.normName('  Aman   SHARMA. ') === v.normName('aman sharma'));
});

// ---------------------------------------------------------------- import preview
test('import endpoints require an admin', async () => {
  assert.strictEqual((await api('/admin/imports')).status, 401);
  const stu = await activeStudent('role');
  const t = (await login(stu.email)).data.token;
  assert.strictEqual((await upload(HEADER + '\n', { token: t })).status, 403);
  assert.strictEqual((await api('/admin/imports', { token: t })).status, 403);
  assert.strictEqual((await api(`/admin/users/${stu.id}/activation-link`, { method: 'POST', token: t, body: {} })).status, 403);
});

test('preview rejects bad files: wrong extension, empty, binary, missing column, duplicate column, no rows, too big, too many rows', async () => {
  assert.strictEqual((await upload(HEADER + '\n', { filename: 'students.txt' })).status, 400);
  assert.strictEqual((await upload('')).status, 400);
  assert.strictEqual((await upload('a\u0000b,c')).status, 400);
  const miss = await upload('student_id,name,email\nX1,A,a@b.co\n');
  assert.strictEqual(miss.status, 400);
  assert.match(miss.data.error, /department/);
  assert.deepStrictEqual(miss.data.missing, ['department', 'programme', 'academic_year', 'semester']);
  assert.strictEqual((await upload(HEADER + ',name\n')).status, 400);
  assert.strictEqual((await upload(HEADER + '\n')).status, 400);
  assert.strictEqual((await upload(HEADER + '\n' + 'x'.repeat(3 * 1024 * 1024))).status, 413);
  const many = [HEADER, ...Array.from({ length: 5001 }, (_, i) => row(`m${i}`))].join('\n');
  assert.strictEqual((await upload(many)).status, 400);
});

test('preview: row-wise errors, no writes to users, duplicates inside the file and against the database', async () => {
  const existing = await activeStudent('exist');
  const before = (await pool.query(`SELECT COUNT(*)::int c FROM users WHERE enrollment_no LIKE $1`, [`${P}%`])).rows[0].c;
  const csv = [
    HEADER,
    row('ok1'),                                                          // line 2 valid (dept by code)
    row('ok2', { dept: 'Information Technology', year: '2025-2026' }),   // line 3 valid (dept by full name)
    row('badmail', { email: 'not-an-email' }),                           // line 4
    `${P}-nodept,No Dept,${P}.nd@college.test,,BTech,2025-26,3`,         // line 5 missing department
    row('baddept', { dept: 'Astrology' }),                               // line 6
    row('badsem', { sem: '13' }),                                        // line 7
    row('badyear', { year: '2025-30' }),                                 // line 8
    row('formula', { name: '"=HYPERLINK(""x"")"' }),                      // line 9 (properly quoted CSV field)
    row('ok1'),                                                          // line 10 duplicate id+email of line 2
    `${P}-ok1b,Other,${P}.ok2@college.test,CSE,BTech,2025-26,3`,         // line 11 duplicate email of line 3
    `${existing.enrollment_no},Clash,${P}.clash@college.test,CSE,BTech,2025-26,3`, // line 12 id already in DB
    `${P}-clash2,Clash,${existing.email},CSE,BTech,2025-26,3`,           // line 13 email already in DB
    `${P}-short,Short,${P}.short@college.test,CSE,BTech`,                // line 14 wrong column count
  ].join('\r\n') + '\r\n';
  const r = await upload(csv);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.total_rows, 13);
  assert.strictEqual(r.data.valid_rows, 2);
  assert.strictEqual(r.data.error_rows, 11);
  const byLine = Object.fromEntries(r.data.errors.map((e) => [e.line, e.messages.join(' | ')]));
  assert.match(byLine[4], /email is not a valid/);
  assert.match(byLine[5], /department is missing/);
  assert.match(byLine[6], /department "Astrology" does not exist/);
  assert.match(byLine[7], /semester/);
  assert.match(byLine[8], /academic_year/);
  assert.match(byLine[9], /must not start with/);
  assert.match(byLine[10], /duplicate student_id \(first seen on line 2\).*duplicate email/);
  assert.match(byLine[11], /duplicate email \(first seen on line 3\)/);
  assert.match(byLine[12], /student_id already exists/);
  assert.match(byLine[13], /email is already registered/);
  assert.match(byLine[14], /expected 7 columns but found 5/);
  assert.strictEqual(r.data.sample.length, 2);
  assert.strictEqual(r.data.sample[1].department, 'Information Technology');
  assert.strictEqual(r.data.sample[1].academic_year, '2025-2026');
  const after = (await pool.query(`SELECT COUNT(*)::int c FROM users WHERE enrollment_no LIKE $1`, [`${P}%`])).rows[0].c;
  assert.strictEqual(after, before, 'preview must not create any user');
});

// ---------------------------------------------------------------- confirm
test('confirm creates INVITED accounts with no password; double-confirm is refused; history + audit recorded', async () => {
  const p = await upload([HEADER, row('c1'), row('c2'), row('c3', { email: 'bad' })].join('\n') + '\n');
  assert.strictEqual(p.data.valid_rows, 2);
  const c = await api(`/admin/students/import/${p.data.batch_id}/confirm`, { method: 'POST', token: adminToken, body: {} });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(c.data.imported, 2);
  assert.strictEqual(c.data.failed, 1);
  assert.strictEqual(c.data.invitations.mode, 'NONE', 'no mail service -> must not claim emails were sent');

  const u = await userByEmail(`${P}.c1@college.test`);
  assert.strictEqual(u.status, 'INVITED');
  assert.strictEqual(u.role, 'student');
  assert.strictEqual(u.password_hash, null);
  assert.strictEqual(u.is_active, false);
  assert.strictEqual(u.department, 'Computer Science & Engineering');
  assert.strictEqual(u.programme, 'BTech');
  assert.strictEqual(u.academic_year, '2025-2026');
  assert.strictEqual(u.semester, '3');
  assert.strictEqual(u.enrollment_no, `${P}-c1`.toUpperCase());

  const again = await api(`/admin/students/import/${p.data.batch_id}/confirm`, { method: 'POST', token: adminToken, body: {} });
  assert.strictEqual(again.status, 409);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int c FROM users WHERE import_batch_id = $1`, [p.data.batch_id])).rows[0].c, 2);

  const hist = await api('/admin/imports', { token: adminToken });
  const h = hist.data.imports.find((i) => i.id === p.data.batch_id);
  assert.strictEqual(h.status, 'COMMITTED');
  assert.strictEqual(h.imported_count, 2);
  assert.strictEqual(h.still_invited, 2);
  const detail = await api(`/admin/imports/${p.data.batch_id}`, { token: adminToken });
  assert.strictEqual(detail.data.import.errors.length, 1);
  const audit = await pool.query(`SELECT actor_id, details FROM admin_audit_log WHERE action='STUDENT_IMPORT' AND target_id=$1`, [String(p.data.batch_id)]);
  assert.strictEqual(audit.rows.length, 1);
  assert.strictEqual(audit.rows[0].actor_id, adminId);
  assert.strictEqual(audit.rows[0].details.imported, 2);
});

test('INVITED student cannot sign in (no password exists), same generic error as a wrong password', async () => {
  const u = await userByEmail(`${P}.c1@college.test`);
  const r = await login(u.email, 'AnyPassword1');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'Invalid email or password');
});

test('a row that becomes a duplicate between preview and confirm is skipped and reported, never duplicated', async () => {
  const p = await upload([HEADER, row('race1'), row('race2')].join('\n') + '\n');
  assert.strictEqual(p.data.valid_rows, 2);
  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(`INSERT INTO users (name,email,password_hash,role,enrollment_no) VALUES ('Racer',$1,$2,'student',$3)`,
    [`${P}.race2@college.test`, hash, `${P}-race2`.toUpperCase()]);
  const c = await api(`/admin/students/import/${p.data.batch_id}/confirm`, { method: 'POST', token: adminToken, body: {} });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(c.data.imported, 1);
  assert.strictEqual(c.data.skipped_at_confirm, 1);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int c FROM users WHERE LOWER(email)=$1`, [`${P}.race2@college.test`])).rows[0].c, 1);
});

test('confirm is all-or-nothing: a failure part-way leaves zero accounts and the batch still PREVIEW', async () => {
  const p = await upload([HEADER, row('at1'), row('at2')].join('\n') + '\n');
  // Corrupt the stored payload so the 2nd row violates NOT NULL(name): the INSERT as a whole must fail.
  await pool.query(`UPDATE import_batches SET payload = jsonb_set(payload, '{1,name}', 'null'::jsonb) WHERE id = $1`, [p.data.batch_id]);
  const c = await api(`/admin/students/import/${p.data.batch_id}/confirm`, { method: 'POST', token: adminToken, body: {} });
  assert.strictEqual(c.status, 500);
  assert.match(c.data.error, /nothing was saved/);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int c FROM users WHERE enrollment_no LIKE $1`, [`${P}-AT%`])).rows[0].c, 0);
  assert.strictEqual((await pool.query('SELECT status FROM import_batches WHERE id=$1', [p.data.batch_id])).rows[0].status, 'PREVIEW');
});

test('cancelled and expired previews cannot be confirmed', async () => {
  const p = await upload([HEADER, row('cx1')].join('\n') + '\n');
  assert.strictEqual((await api(`/admin/students/import/${p.data.batch_id}/cancel`, { method: 'POST', token: adminToken, body: {} })).status, 200);
  assert.strictEqual((await api(`/admin/students/import/${p.data.batch_id}/confirm`, { method: 'POST', token: adminToken, body: {} })).status, 409);
  const q = await upload([HEADER, row('cx2')].join('\n') + '\n');
  await pool.query(`UPDATE import_batches SET created_at = NOW() - interval '25 hours' WHERE id=$1`, [q.data.batch_id]);
  assert.strictEqual((await api(`/admin/students/import/${q.data.batch_id}/confirm`, { method: 'POST', token: adminToken, body: {} })).status, 410);
  assert.strictEqual((await api('/admin/students/import/999999/confirm', { method: 'POST', token: adminToken, body: {} })).status, 404);
});

test('database itself blocks duplicate student IDs and emails (case-insensitive)', async () => {
  const u = await activeStudent('dbdup');
  await assert.rejects(pool.query(`INSERT INTO users (name,email,role,status,enrollment_no) VALUES ('x',$1,'student','INVITED',$2)`, [`other.${P}@college.test`, u.enrollment_no.toLowerCase()]), /users_student_id_uq|duplicate key/);
  await assert.rejects(pool.query(`INSERT INTO users (name,email,role,status,enrollment_no) VALUES ('x',$1,'student','INVITED',$2)`, [u.email.toUpperCase(), `${P}-zzz`]), /duplicate key/);
});

test('database refuses an ACTIVE account without a password', async () => {
  await assert.rejects(pool.query(`INSERT INTO users (name,email,role,status,is_active) VALUES ('x',$1,'student','ACTIVE',true)`, [`${P}.nopw@college.test`]), /users_active_has_password/);
});

// ---------------------------------------------------------------- activation tokens
test('activation: weak password does NOT consume the token; strong password activates; token is single-use', async () => {
  await importAndConfirm([row('act')]);
  const u = await userByEmail(`${P}.act@college.test`);
  const t = await handoff(u.id);

  const info = await api('/auth/token-info', { method: 'POST', body: { token: t } });
  assert.strictEqual(info.status, 200);
  assert.strictEqual(info.data.purpose, 'ACTIVATION');
  assert.strictEqual(info.data.name, 'Student act');
  assert.match(info.data.email, /^p3\*+@college\.test$/);
  assert.ok(!JSON.stringify(info.data).includes(u.email), 'email must be masked');

  const weak = await api('/auth/activate', { method: 'POST', body: { token: t, password: 'short' } });
  assert.strictEqual(weak.status, 400);
  assert.strictEqual((await userByEmail(u.email)).status, 'INVITED');

  const ok = await api('/auth/activate', { method: 'POST', body: { token: t, password: PASSWORD } });
  assert.strictEqual(ok.status, 200);
  const after = await userByEmail(u.email);
  assert.strictEqual(after.status, 'ACTIVE');
  assert.strictEqual(after.is_active, true);
  assert.match(after.password_hash, /^\$2[aby]\$/, 'password must be a bcrypt hash');
  assert.ok(after.activated_at);
  assert.strictEqual(after.email_verified_at, null, 'admin hand-off does NOT prove email ownership');
  const used = (await pool.query('SELECT used_at FROM auth_tokens WHERE token_hash=$1', [sha256(t)])).rows[0];
  assert.ok(used.used_at);

  assert.strictEqual((await login(u.email)).status, 200);
  const reuse = await api('/auth/activate', { method: 'POST', body: { token: t, password: 'Another@1234' } });
  assert.strictEqual(reuse.status, 400);
  assert.strictEqual(reuse.data.code, 'TOKEN_INVALID_OR_EXPIRED');
  const n = await pool.query(`SELECT title FROM notifications WHERE user_id=$1`, [u.id]);
  assert.ok(n.rows.some((x) => x.title === 'Account Activated'));
});

test('tokens are stored only as SHA-256 hashes', async () => {
  await importAndConfirm([row('hash')]);
  const u = await userByEmail(`${P}.hash@college.test`);
  const t = await handoff(u.id);
  const all = await pool.query(`SELECT token_hash FROM auth_tokens WHERE user_id=$1`, [u.id]);
  assert.ok(all.rows.every((r) => r.token_hash !== t && /^[0-9a-f]{64}$/.test(r.token_hash)));
  const leaked = await pool.query(`SELECT 1 FROM auth_tokens WHERE token_hash=$1`, [t]);
  assert.strictEqual(leaked.rows.length, 0);
  assert.ok(t.length >= 40, 'token must carry >= 256 bits of entropy');
});

test('invalid, garbage, expired, revoked and wrong-purpose tokens are all rejected with the same message', async () => {
  await importAndConfirm([row('bad')]);
  const u = await userByEmail(`${P}.bad@college.test`);
  const good = await handoff(u.id);

  for (const bad of ['', 'x', 'a'.repeat(43), 'a'.repeat(500), null, 12345, { $ne: 1 }]) {
    const r = await api('/auth/activate', { method: 'POST', body: { token: bad, password: PASSWORD } });
    assert.strictEqual(r.status, 400, `token ${JSON.stringify(bad)}`);
    assert.strictEqual(r.data.code, 'TOKEN_INVALID_OR_EXPIRED');
  }
  rateLimit.resetAll(); // the loop above legitimately used most of the activation attempt budget
  // expired
  await pool.query(`UPDATE auth_tokens SET expires_at = NOW() - interval '1 minute' WHERE token_hash=$1`, [sha256(good)]);
  const exp = await api('/auth/activate', { method: 'POST', body: { token: good, password: PASSWORD } });
  assert.strictEqual(exp.status, 400);
  assert.strictEqual(exp.data.code, 'TOKEN_INVALID_OR_EXPIRED');
  assert.strictEqual((await api('/auth/token-info', { method: 'POST', body: { token: good } })).status, 400);

  // re-issuing revokes the previous token
  const t2 = await handoff(u.id);
  const t3 = await handoff(u.id);
  assert.strictEqual((await api('/auth/activate', { method: 'POST', body: { token: t2, password: PASSWORD } })).status, 400, 'older token revoked by newer one');

  // an activation token cannot be used to reset a password
  assert.strictEqual((await api('/auth/reset-password', { method: 'POST', body: { token: t3, password: PASSWORD } })).status, 400);
  assert.strictEqual((await userByEmail(u.email)).status, 'INVITED');
  assert.strictEqual((await api('/auth/activate', { method: 'POST', body: { token: t3, password: PASSWORD } })).status, 200);
});

test('two simultaneous activations with the same token: exactly one succeeds', async () => {
  await importAndConfirm([row('race')]);
  const u = await userByEmail(`${P}.race@college.test`);
  const t = await handoff(u.id);
  const results = await Promise.all([1, 2, 3, 4].map((i) => api('/auth/activate', { method: 'POST', body: { token: t, password: `Racer${i}@12345` } })));
  assert.strictEqual(results.filter((r) => r.status === 200).length, 1);
  assert.strictEqual(results.filter((r) => r.status === 400).length, 3);
});

test('a SUSPENDED invited account cannot be activated even with a valid token', async () => {
  await importAndConfirm([row('susp')]);
  const u = await userByEmail(`${P}.susp@college.test`);
  const t = await handoff(u.id);
  await pool.query(`UPDATE users SET status='SUSPENDED' WHERE id=$1`, [u.id]);
  assert.strictEqual((await api('/auth/activate', { method: 'POST', body: { token: t, password: PASSWORD } })).status, 400);
  assert.strictEqual((await api('/admin/users/' + u.id + '/activation-link', { method: 'POST', token: adminToken, body: {} })).status, 409);
});

// ---------------------------------------------------------------- admin hand-off
test('bulk activation-links CSV: one link per un-activated student, hashes only in DB, audited, no secrets in audit', async () => {
  const { batch } = await importAndConfirm([row('bl1'), row('bl2'), row('bl3')]);
  const u3 = await userByEmail(`${P}.bl3@college.test`);
  const t3 = await handoff(u3.id);
  await api('/auth/activate', { method: 'POST', body: { token: t3, password: PASSWORD } }); // bl3 activates first

  const res = await api(`/admin/imports/${batch}/activation-links`, { method: 'POST', token: adminToken, body: {}, raw: true });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  const lines = (await res.text()).trim().split(/\r\n/);
  assert.strictEqual(lines[0], 'student_id,name,email,activation_link,expires_at');
  assert.strictEqual(lines.length, 3, 'header + 2 still-invited students (bl3 already active)');
  const links = lines.slice(1).map((l) => l.match(/"(https?:[^"]+)"/)[1]);
  links.forEach((l) => { assert.match(l, /\/activate#token=[\w-]{40,}$/); secrets.push(l.split('#token=')[1]); });
  const u1 = await userByEmail(`${P}.bl1@college.test`);
  assert.strictEqual((await api('/auth/activate', { method: 'POST', body: { token: links[0].split('#token=')[1], password: PASSWORD } })).status, 200);
  assert.strictEqual((await userByEmail(u1.email)).status, 'ACTIVE');

  const audit = await pool.query(`SELECT details FROM admin_audit_log WHERE action='ACTIVATION_LINKS_GENERATED' AND target_id=$1`, [String(batch)]);
  assert.strictEqual(audit.rows.length, 1);
  assert.deepStrictEqual(audit.rows[0].details, { count: 2 });
  const preCommit = await upload([HEADER, row('bl9')].join('\n') + '\n');
  assert.strictEqual((await api(`/admin/imports/${preCommit.data.batch_id}/activation-links`, { method: 'POST', token: adminToken, body: {}, raw: true })).status, 409);
});

test('per-user link: INVITED -> activation, ACTIVE -> password reset, admins/suspended refused, EMAIL refused without SMTP', async () => {
  await importAndConfirm([row('pu')]);
  const inv = await userByEmail(`${P}.pu@college.test`);
  const a = await api(`/admin/users/${inv.id}/activation-link`, { method: 'POST', token: adminToken, body: {} });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.data.purpose, 'ACTIVATION');
  assert.match(a.data.link, /\/activate#token=/);
  assert.strictEqual(a.data.email_sent, false);
  tokenOf(a.data.link);

  const act = await activeStudent('pu2');
  const r = await api(`/admin/users/${act.id}/activation-link`, { method: 'POST', token: adminToken, body: {} });
  assert.strictEqual(r.data.purpose, 'PASSWORD_RESET');
  assert.match(r.data.link, /\/reset-password#token=/);
  tokenOf(r.data.link);

  assert.strictEqual((await api(`/admin/users/${adminId}/activation-link`, { method: 'POST', token: adminToken, body: {} })).status, 403);
  assert.strictEqual((await api(`/admin/users/${act.id}/activation-link`, { method: 'POST', token: adminToken, body: { delivery: 'EMAIL' } })).status, 409);
  assert.strictEqual((await api('/admin/users/999999/activation-link', { method: 'POST', token: adminToken, body: {} })).status, 404);
});

// ---------------------------------------------------------------- Method B: verified self-registration
test('request-activation (no email service): all three fields must match; token/link never returned; admins are notified', async () => {
  await importAndConfirm([row('self')]);
  const id = `${P}-self`; const email = `${P}.self@college.test`;
  const ask = (b) => api('/auth/request-activation', { method: 'POST', body: b });

  for (const bad of [
    { student_id: id, email, name: 'Someone Else' },                    // wrong name
    { student_id: `${P}-nope`, email, name: 'Student self' },            // wrong id
    { student_id: id, email: `x.${email}`, name: 'Student self' },       // wrong email
    { student_id: 'ZZZ999', email: 'a@college.test', name: 'Nobody' },   // not on roster at all
  ]) {
    const r = await ask(bad);
    assert.strictEqual(r.status, 404, JSON.stringify(bad));
    assert.strictEqual(r.data.code, 'RECORD_NOT_FOUND');
    assert.match(r.data.error, /contact your college administrator/i);
  }
  assert.strictEqual((await ask({ student_id: id, email })).status, 400, 'name is required');

  // matching is forgiving about case/spacing/punctuation of the NAME and case of id/email only
  const ok = await ask({ student_id: id.toLowerCase(), email: email.toUpperCase(), name: '  student   SELF. ' });
  assert.strictEqual(ok.status, 202);
  assert.strictEqual(ok.data.delivery, 'ADMIN');
  assert.doesNotMatch(JSON.stringify(ok.data), /#token|https?:|"token"|"link"/i, 'public response must not carry a link or token');
  assert.doesNotMatch(ok.data.message, /has been sent|emailed/i, 'must not claim an email was sent');
  const n = await pool.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND title='Activation Requested' AND message LIKE $2`, [adminId, `%${id.toUpperCase()}%`]);
  assert.strictEqual(n.rows.length, 1);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int c FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=$1`, [email])).rows[0].c, 0, 'no token issued without a delivery channel');
});

test('request-activation: ACTIVE -> 409, SUSPENDED -> 403, faculty/admin cannot use the student flow, rate limited per student ID', async () => {
  const act = await activeStudent('self2');
  const ask = (b) => api('/auth/request-activation', { method: 'POST', body: b });
  const r1 = await ask({ student_id: act.enrollment_no, email: act.email, name: 'Student self2' });
  assert.strictEqual(r1.status, 409);
  assert.strictEqual(r1.data.code, 'ALREADY_ACTIVE');
  await pool.query(`UPDATE users SET status='SUSPENDED', is_active=false WHERE id=$1`, [act.id]);
  assert.strictEqual((await ask({ student_id: act.enrollment_no, email: act.email, name: 'Student self2' })).status, 403);

  const hash = await bcrypt.hash(PASSWORD, 4);
  const f = await pool.query(`INSERT INTO users (name,email,password_hash,role,enrollment_no) VALUES ('Fac',$1,$2,'faculty',$3) RETURNING id`, [`${P}.fac@college.test`, hash, `${P}-FAC`]);
  const rf = await ask({ student_id: `${P}-FAC`, email: `${P}.fac@college.test`, name: 'Fac' });
  assert.strictEqual(rf.status, 404, 'only role=student records can self-activate');

  let last;
  for (let i = 0; i < 6; i++) last = await ask({ student_id: 'RATE-ID', email: 'r@college.test', name: 'R' });
  assert.strictEqual(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.ok(f.rows[0].id);
});

test('with an email service: request-activation emails the link (verified email), failure -> 502 and no live token', async () => {
  await importAndConfirm([row('mail1'), row('mail2')]);
  const stub = stubTransport();
  mailer.setTransportForTests(stub);
  try {
    const email = `${P}.mail1@college.test`;
    const r = await api('/auth/request-activation', { method: 'POST', body: { student_id: `${P}-mail1`, email, name: 'Student mail1' } });
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.data.delivery, 'EMAIL');
    assert.doesNotMatch(JSON.stringify(r.data), /#token|https?:/);
    assert.strictEqual(stub.sent.length, 1);
    assert.strictEqual(stub.sent[0].to, email);
    const m = stub.sent[0].text.match(/(https?:\/\/\S+#token=(\S+))/);
    assert.ok(m, 'email must contain the activation link');
    secrets.push(m[2]);
    assert.strictEqual((await api('/auth/activate', { method: 'POST', body: { token: m[2], password: PASSWORD } })).status, 200);
    assert.ok((await userByEmail(email)).email_verified_at, 'activation via emailed link verifies the email');

    mailer.setTransportForTests({ sendMail: async () => { throw new Error('SMTP down'); } });
    const bad = await api('/auth/request-activation', { method: 'POST', body: { student_id: `${P}-mail2`, email: `${P}.mail2@college.test`, name: 'Student mail2' } });
    assert.strictEqual(bad.status, 502);
    assert.strictEqual((await pool.query(`SELECT COUNT(*)::int c FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=$1 AND t.used_at IS NULL AND t.revoked_at IS NULL`, [`${P}.mail2@college.test`])).rows[0].c, 0);
  } finally { mailer.setTransportForTests(null); }
});

test('with an email service: bulk import sends one invitation per imported student and records counts', async () => {
  const stub = stubTransport();
  mailer.setTransportForTests(stub);
  try {
    const { batch, invitations, imported } = await importAndConfirm([row('inv1'), row('inv2')]);
    assert.strictEqual(invitations.mode, 'EMAIL');
    assert.strictEqual(imported, 2);
    for (let i = 0; i < 50; i++) {
      const b = (await pool.query('SELECT invites_sent FROM import_batches WHERE id=$1', [batch])).rows[0];
      if (b.invites_sent === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual((await pool.query('SELECT invites_sent, invites_failed FROM import_batches WHERE id=$1', [batch])).rows[0].invites_sent, 2);
    assert.deepStrictEqual(stub.sent.map((m) => m.to).sort(), [`${P}.inv1@college.test`, `${P}.inv2@college.test`]);
    stub.sent.forEach((m) => { const t = m.text.match(/#token=(\S+)/)[1]; secrets.push(t); });
    const d = (await pool.query(`SELECT delivery FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE u.email=$1`, [`${P}.inv1@college.test`])).rows[0];
    assert.strictEqual(d.delivery, 'EMAIL');
  } finally { mailer.setTransportForTests(null); }
});

test('activation attempts are rate limited per IP (429 + Retry-After)', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await api('/auth/activate', { method: 'POST', body: { token: 'a'.repeat(43), password: PASSWORD } });
  assert.strictEqual(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});

// ---------------------------------------------------------------- closed registration & reset
test('open registration is closed (410) and creates nothing', async () => {
  const r = await api('/auth/register', { method: 'POST', body: { name: 'Hacker', email: `${P}.hack@college.test`, password: PASSWORD, role: 'admin' } });
  assert.strictEqual(r.status, 410);
  assert.strictEqual((await userByEmail(`${P}.hack@college.test`)), undefined);
});

test('forgot-password without email service says so honestly; with one it never reveals whether the account exists', async () => {
  const none = await api('/auth/forgot-password', { method: 'POST', body: { email: 'anyone@college.test' } });
  assert.strictEqual(none.status, 200);
  assert.strictEqual(none.data.delivery, 'ADMIN');
  assert.match(none.data.message, /not set up/i);
  assert.strictEqual((await api('/auth/config')).data.email_delivery, false);

  const u = await activeStudent('fp');
  const stub = stubTransport();
  mailer.setTransportForTests(stub);
  try {
    assert.strictEqual((await api('/auth/config')).data.email_delivery, true);
    const a = await api('/auth/forgot-password', { method: 'POST', body: { email: `nobody.${P}@college.test` } });
    const b = await api('/auth/forgot-password', { method: 'POST', body: { email: u.email } });
    assert.strictEqual(a.status, 200);
    assert.deepStrictEqual(a.data, b.data, 'identical response for unknown and known accounts');
    assert.strictEqual(stub.sent.length, 1, 'only the real account gets an email');
    const t = stub.sent[0].text.match(/#token=(\S+)/)[1];
    secrets.push(t);

    const oldSession = (await login(u.email)).data.token;
    await new Promise((r) => setTimeout(r, 1100));
    assert.strictEqual((await api('/auth/activate', { method: 'POST', body: { token: t, password: 'Brand@New123' } })).status, 400, 'reset token is not an activation token');
    assert.strictEqual((await api('/auth/reset-password', { method: 'POST', body: { token: t, password: 'weak' } })).status, 400);
    const ok = await api('/auth/reset-password', { method: 'POST', body: { token: t, password: 'Brand@New123' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await login(u.email, PASSWORD)).status, 401);
    assert.strictEqual((await login(u.email, 'Brand@New123')).status, 200);
    assert.strictEqual((await api('/auth/me', { token: oldSession })).status, 401, 'sessions from before the reset are revoked');
    assert.strictEqual((await api('/auth/reset-password', { method: 'POST', body: { token: t, password: 'Another@12345' } })).status, 400, 'single use');
  } finally { mailer.setTransportForTests(null); }
});

// ---------------------------------------------------------------- audit + secrecy (run last)
test('admin audit log is append-only', async () => {
  const id = (await pool.query(`SELECT id FROM admin_audit_log ORDER BY id DESC LIMIT 1`)).rows[0].id;
  await assert.rejects(pool.query(`UPDATE admin_audit_log SET action='X' WHERE id=$1`, [id]), /append-only/);
  await assert.rejects(pool.query(`DELETE FROM admin_audit_log WHERE id=$1`, [id]), /append-only/);
});

test('no activation/reset token ever appeared in server logs or in the audit log', async () => {
  assert.ok(secrets.length >= 10, `expected to have observed many tokens, saw ${secrets.length}`);
  const blob = logged.join('\n');
  const audit = JSON.stringify((await pool.query('SELECT details FROM admin_audit_log')).rows);
  for (const s of secrets) {
    assert.ok(!blob.includes(s), 'token found in logs');
    assert.ok(!audit.includes(s), 'token found in audit log');
  }
});
