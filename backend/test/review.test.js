// Phase 6 tests: reviewer queue filters/pagination/scope, review decisions, stale-version protection,
// concurrency, duplicate warnings, dashboard summary, review history and audit entries.
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
const P = `p6${Date.now()}`;
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
const get = (p, t) => send(p, { token: t.token });
const decide = (t, id, kind, json = {}) => send(`/activities/${id}/${kind}`, { method: 'PATCH', token: t.token, json });
async function student(dept = DEPT) { return makeUser({ role: 'student', department: dept }); }
const reviewerFor = (...departments) => reviewer({ scope: { all: false, departments } });

// ------------------------------------------------------------------ queue filters
test('queue: every filter is applied by the server, scoped to the reviewer, with paging and sorting', async () => {
  const f = await reviewerFor(DEPT);
  const s1 = await student(); const s2 = await student();
  const a = await submit(s1, { title: 'Alpha Hackathon', category: 'hackathon', academic_session: '2024-2025', semester: '3' });
  const b = await submit(s1, { title: 'Beta Workshop', category: 'workshop', academic_session: '2025-2026', semester: '5' });
  const c = await submit(s2, { title: 'Gamma Sports Meet', category: 'sports', academic_session: '2025-2026', semester: '5' });
  const mine = [a.id, b.id, c.id];
  const q = async (qs) => ids(await get(`/activities/pending?limit=50&${qs}`, f));

  assert.deepStrictEqual(sorted(await q('')), sorted(mine), 'scope: only my department, nothing else');
  assert.deepStrictEqual(ids(await get('/activities/pending?limit=50', f)), mine, 'with no sort given, the longest-waiting submission is first');
  assert.deepStrictEqual(await q('sort=oldest'), mine);
  assert.deepStrictEqual(await q('sort=newest'), [...mine].reverse());
  assert.deepStrictEqual(await q('category=workshop'), [b.id]);
  assert.deepStrictEqual(await q('academic_session=2024-2025'), [a.id]);
  assert.deepStrictEqual(sorted(await q('semester=5')), sorted([b.id, c.id]));
  assert.deepStrictEqual(await q('search=gamma'), [c.id], 'title search, case-insensitive');
  assert.deepStrictEqual(sorted(await q(`search=${encodeURIComponent(s1.email)}`)), sorted([a.id, b.id]), 'search by student email');
  assert.deepStrictEqual(sorted(await q(`search=${(await pool.query('SELECT enrollment_no n FROM users WHERE id=$1', [s2.id])).rows[0].n}`)), [c.id], 'search by enrolment number');
  assert.deepStrictEqual(await q('search=%25'), [], 'a literal % is not a wildcard');
  assert.deepStrictEqual(await q(`department=${encodeURIComponent(DEPT)}`).then(sorted), sorted(mine));
  assert.deepStrictEqual(await q(`department=${encodeURIComponent(OTHER_DEPT)}`), [], 'asking for a department outside my scope yields nothing');
  const today = (await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d; // the database's own idea of "today"
  assert.deepStrictEqual(sorted(await q(`date_from=${today}&date_to=${today}`)), sorted(mine), 'submitted today');
  assert.deepStrictEqual(await q('date_from=2999-01-01'), [], 'nothing was submitted in the far future');
  assert.deepStrictEqual(await q('date_to=2000-01-01'), []);
  assert.deepStrictEqual(await q('status=resubmitted'), []);
  assert.deepStrictEqual(await q('duplicate=true'), []);
  assert.deepStrictEqual(await q('category=hackathon&semester=3&academic_session=2024-2025&search=alpha'), [a.id], 'filters combine with AND');

  assert.strictEqual((await get('/activities/pending?limit=100000', f)).data.limit, 50, 'page size is capped');
  const p1 = await get('/activities/pending?limit=2&page=1&sort=oldest', f);
  const p2 = await get('/activities/pending?limit=2&page=2&sort=oldest', f);
  assert.deepStrictEqual([p1.data.total, p1.data.pages, p1.data.page, p1.data.limit], [3, 2, 1, 2]);
  assert.deepStrictEqual([...ids(p1), ...ids(p2)], mine, 'pages are contiguous and complete');

  for (const bad of ['status=approved', 'status=bogus', 'sort=bogus', 'semester=abc', 'academic_session=nope', 'date_from=2026-13-40', 'date_from=2026-05-02&date_to=2026-05-01']) {
    assert.strictEqual((await get(`/activities/pending?${bad}`, f)).status, 400, bad);
  }
  const nothing = await reviewerFor(OTHER_DEPT);
  assert.deepStrictEqual(ids(await get('/activities/pending?limit=50', nothing)), [], 'out-of-scope faculty sees an empty queue');
  const none = await reviewer({ scope: { all: false, departments: [] } });
  assert.deepStrictEqual(ids(await get('/activities/pending?limit=50', none)), [], 'no scope = no records');
  for (const role of [s1]) for (const url of ['/activities/pending', '/activities/history', '/activities/review/summary']) {
    assert.strictEqual((await get(url, role)).status, 403, url);
  }
});

// ------------------------------------------------------------------ decisions
test('decisions: remarks rules, one decision per submission, audit entry and notification together', async () => {
  const f = await reviewerFor(DEPT); const s = await student();
  const act = await submit(s);
  assert.strictEqual((await decide(f, act.id, 'reject', {})).status, 400);
  assert.strictEqual((await decide(f, act.id, 'reject', { remarks: '   ' })).status, 400, 'whitespace is not a remark');
  assert.strictEqual((await decide(f, act.id, 'request-correction', {})).status, 400);
  assert.strictEqual((await decide(f, act.id, 'approve', { remarks: 'x'.repeat(1001) })).status, 400, 'too long');
  assert.strictEqual((await decide(f, act.id, 'approve', { remarks: 'bad\u0000text' })).status, 400, 'control characters');
  assert.strictEqual((await decide(f, act.id, 'approve', { expected_version: 'one' })).status, 400);
  assert.strictEqual((await pool.query('SELECT status FROM activities WHERE id=$1', [act.id])).rows[0].status, 'pending', 'rejected input changed nothing');
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM audit_log WHERE activity_id=$1', [act.id])).rows[0].n, 1, 'only the submission is audited');

  const ok = await decide(f, act.id, 'approve');
  assert.strictEqual(ok.status, 200, 'approval does not need remarks');
  assert.strictEqual(ok.data.status, 'approved');
  for (const kind of ['approve', 'reject', 'request-correction']) {
    const again = await decide(f, act.id, kind, { remarks: 'second try', notes: 'second try' });
    assert.strictEqual(again.status, 409, `${kind} after a final decision`);
  }
  const audit = (await pool.query('SELECT * FROM audit_log WHERE activity_id=$1 ORDER BY id', [act.id])).rows;
  assert.strictEqual(audit.length, 2);
  assert.deepStrictEqual([audit[1].old_status, audit[1].new_status, audit[1].reviewer_id, audit[1].student_id, audit[1].version], ['pending', 'approved', f.id, s.id, 1]);
  const notes = (await get('/notifications', s)).data;
  const list = Array.isArray(notes) ? notes : notes.notifications;
  assert.ok(list.some((n) => /approved/i.test(n.title) && n.link === `/activity/${act.id}`), 'student was notified');

  const rej = await submit(s);
  const r = await decide(f, rej.id, 'reject', { remarks: 'Certificate is unreadable' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.review_remarks, 'Certificate is unreadable');
  const cor = await submit(s);
  const c = await decide(f, cor.id, 'request-correction', { notes: 'Add the organiser name' });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(c.data.correction_notes, 'Add the organiser name');
  const other = await reviewerFor(OTHER_DEPT);
  const fresh = await submit(s);
  assert.strictEqual((await decide(other, fresh.id, 'approve')).status, 403, 'outside scope');
  assert.strictEqual((await decide(s, fresh.id, 'approve')).status, 403, 'students cannot decide');
  assert.strictEqual((await decide(f, 999999999, 'approve')).status, 404);
  assert.strictEqual((await decide(f, 'abc', 'approve')).status, 400);
});

test('concurrent decisions: exactly one wins and exactly one audit entry is written', async () => {
  const f1 = await reviewerFor(DEPT); const f2 = await reviewerFor(DEPT); const s = await student();
  const act = await submit(s);
  const results = await Promise.all([
    decide(f1, act.id, 'approve'), decide(f2, act.id, 'reject', { remarks: 'No' }),
    decide(f1, act.id, 'approve'), decide(f2, act.id, 'request-correction', { notes: 'Fix' }),
  ]);
  const codes = results.map((r) => r.status).sort();
  assert.deepStrictEqual(codes, [200, 409, 409, 409]);
  const winner = results.find((r) => r.status === 200).data.status;
  assert.strictEqual((await pool.query('SELECT status FROM activities WHERE id=$1', [act.id])).rows[0].status, winner);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM audit_log WHERE activity_id=$1 AND old_status='pending'`, [act.id])).rows[0].n, 1);
});

test('a reviewer cannot approve a version they have not seen', async () => {
  const f = await reviewerFor(DEPT); const s = await student();
  const act = await submit(s);
  assert.strictEqual((await decide(f, act.id, 'request-correction', { notes: 'Scan again', expected_version: 1 })).status, 200);
  const re = await send(`/activities/${act.id}/resubmit`, { method: 'PUT', token: s.token, fields: { remarks: 'Rescanned' }, file: pdf() });
  assert.strictEqual(re.status, 200, JSON.stringify(re.data));
  pathsToClean.add(await filePathOf(act.id));
  const stale = await decide(f, act.id, 'approve', { expected_version: 1 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.data.code, 'STALE_VERSION');
  assert.strictEqual(stale.data.current_version, 2);
  assert.strictEqual((await pool.query('SELECT status FROM activities WHERE id=$1', [act.id])).rows[0].status, 'resubmitted', 'nothing changed');
  assert.deepStrictEqual(ids(await get('/activities/pending?limit=50&status=resubmitted&sort=newest', f)).includes(act.id), true);
  assert.strictEqual((await decide(f, act.id, 'approve', { expected_version: 2 })).status, 200);
  const hist = (await pool.query('SELECT version, new_status FROM audit_log WHERE activity_id=$1 ORDER BY id', [act.id])).rows;
  assert.deepStrictEqual(hist.map((h) => `${h.new_status}@v${h.version}`), ['pending@v1', 'correction_requested@v1', 'resubmitted@v2', 'approved@v2'], 'every entry carries the version it applied to');
});

// ------------------------------------------------------------------ history + summary
test('history: decided records only, filterable, reviewer-aware; summary counts match the database', async () => {
  const HD = `Hist ${P}`; // its own department so earlier tests' records cannot leak into these exact counts
  const f1 = await reviewerFor(HD); const f2 = await reviewerFor(HD); const s = await student(HD);
  const a = await submit(s, { title: 'Hist Approved', category: 'workshop' });
  const b = await submit(s, { title: 'Hist Rejected', category: 'sports' });
  const c = await submit(s, { title: 'Hist Correction', category: 'workshop' });
  const waiting = await submit(s, { title: 'Hist Waiting' });
  await decide(f1, a.id, 'approve'); await decide(f2, b.id, 'reject', { remarks: 'Not valid' }); await decide(f1, c.id, 'request-correction', { notes: 'Fix it' });
  const h = async (qs) => ids(await get(`/activities/history?limit=50&${qs}`, f1));
  assert.deepStrictEqual(sorted(await h('')), sorted([a.id, b.id, c.id]), 'a waiting record is not history');
  assert.deepStrictEqual(await h('status=approved'), [a.id]);
  assert.deepStrictEqual(await h('status=rejected'), [b.id]);
  assert.deepStrictEqual(await h('status=correction_requested'), [c.id]);
  assert.deepStrictEqual(sorted(await h('reviewed_by=me')), sorted([a.id, c.id]), 'only the decisions made by me');
  assert.deepStrictEqual(sorted(await h('category=workshop')), sorted([a.id, c.id]));
  assert.deepStrictEqual(await h('sort=reviewed_newest'), [c.id, b.id, a.id]);
  assert.deepStrictEqual(await h('sort=reviewed_oldest'), [a.id, b.id, c.id]);
  assert.strictEqual((await get('/activities/history?status=pending', f1)).status, 400);
  const row = (await get('/activities/history?limit=50&status=rejected', f1)).data.activities[0];
  assert.strictEqual(row.reviewer_name, `User ${(await pool.query('SELECT split_part(email,\'@\',1) n FROM users WHERE id=$1', [f2.id])).rows[0].n}`);
  assert.strictEqual(row.review_remarks, 'Not valid');
  assert.strictEqual('proof_file_path' in row, false, 'no server paths');

  const sum = (await get('/activities/review/summary', f1)).data;
  assert.deepStrictEqual([sum.pending, sum.approved, sum.rejected, sum.correction_requested], [1, 1, 1, 1]);
  assert.strictEqual(sum.reviewed_by_me, 2);
  assert.deepStrictEqual(sum.recently_reviewed.map((r) => r.id), [c.id, b.id, a.id]);
  assert.ok(!('proof_file_path' in sum.recently_reviewed[0]));
  assert.deepStrictEqual(sum.departments, [HD], 'the department filter lists only departments in my scope');
  const outside = (await get('/activities/review/summary', await reviewerFor(OTHER_DEPT))).data;
  assert.ok(!outside.departments.includes(HD));
  assert.deepStrictEqual([outside.pending, outside.approved, outside.rejected, outside.correction_requested, outside.recently_reviewed.length], [0, 0, 0, 0, 0]);
  const adm = (await get('/activities/review/summary', { token: adminToken })).data;
  assert.ok(adm.pending >= 1 && adm.approved >= 1, 'admin sees everything');
  assert.ok(waiting.id);
});

// ------------------------------------------------------------------ duplicates
test('duplicate warnings: reviewers see the match when it is in their scope; students never do', async () => {
  const sa = await student(); const sb = await student(OTHER_DEPT);
  const file = pdf();
  const first = await submit(sa, { title: 'Original Certificate' }, file);
  const copy = await submit(sb, { title: 'Looks The Same' }, file);
  const both = await reviewer({ scope: { all: true, departments: [] } });
  const onlyB = await reviewerFor(OTHER_DEPT);
  const d = (await get(`/activities/${copy.id}`, both)).data;
  assert.strictEqual(d.is_duplicate, true);
  assert.deepStrictEqual(d.duplicate_info, { id: first.id, title: 'Original Certificate', status: 'pending', student_name: d.duplicate_info.student_name });
  const narrow = (await get(`/activities/${copy.id}`, onlyB)).data;
  assert.deepStrictEqual(narrow.duplicate_info, { out_of_scope: true });
  assert.strictEqual(narrow.duplicate_of, null, 'the id of an out-of-scope record is not disclosed');
  const own = (await get(`/activities/${copy.id}`, sb)).data;
  assert.ok(!('duplicate_of' in own) && !('duplicate_info' in own));
  assert.deepStrictEqual(ids(await get('/activities/pending?limit=50&duplicate=true&sort=newest', onlyB)), [copy.id]);
  const s = (await get('/activities/review/summary', onlyB)).data;
  assert.ok(s.duplicate_warnings >= 1);
  // a flagged record can still be decided normally
  assert.strictEqual((await decide(onlyB, copy.id, 'approve')).status, 200);
});
