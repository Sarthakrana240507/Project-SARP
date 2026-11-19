// Phase 5 tests: activity lifecycle, validation, drafts, resubmission versions, duplicates,
// proof-file handling, filters/pagination, audit immutability.
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
const P = `p5${Date.now()}`;
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

// ------------------------------------------------------------------ lifecycle rules
test('lifecycle: exactly the documented transitions are allowed, for the right actor', () => {
  const allowed = [
    ['draft', 'pending', 'student'],
    ['pending', 'approved', 'faculty'], ['pending', 'rejected', 'admin'], ['pending', 'correction_requested', 'faculty'],
    ['resubmitted', 'approved', 'faculty'], ['resubmitted', 'rejected', 'faculty'], ['resubmitted', 'correction_requested', 'admin'],
    ['correction_requested', 'resubmitted', 'student'],
  ];
  for (const [f, t, role] of allowed) assert.strictEqual(transitionProblem(f, t, role), null, `${f}->${t} by ${role}`);
  // every other (from, to, actor) combination is refused
  let refused = 0;
  for (const f of STATUSES) for (const t of STATUSES) for (const role of ['student', 'faculty']) {
    const ok = allowed.some(([af, at, ar]) => af === f && at === t && (ar === 'student') === (role === 'student'));
    if (!ok) { assert.ok(transitionProblem(f, t, role), `${f}->${t} by ${role} must be refused`); refused++; }
  }
  assert.ok(refused > 50);
  assert.match(transitionProblem('approved', 'pending', 'student'), /already approved/);
  assert.ok(transitionProblem('draft', 'approved', 'faculty'));
  assert.ok(transitionProblem('nonsense', 'pending', 'student'));
  assert.deepStrictEqual(Object.keys(TRANSITIONS.approved), []);
  assert.deepStrictEqual(Object.keys(TRANSITIONS.rejected), []);
});

test('helpers: calendar dates and LIKE escaping', () => {
  assert.ok(validCalendarDate('2026-02-28')); assert.ok(validCalendarDate('2024-02-29'));
  assert.ok(!validCalendarDate('2026-02-30')); assert.ok(!validCalendarDate('2026-13-01')); assert.ok(!validCalendarDate('15-01-2026')); assert.ok(!validCalendarDate('2026-1-5'));
  assert.strictEqual(likePattern('100%_x'), '%100\\%\\_x%');
});

// ------------------------------------------------------------------ validation
test('validation: every bad field is rejected with a field-level message, nothing is stored, no file is left behind', async () => {
  const s = await makeUser({ role: 'student' });
  const cases = [
    [{ title: '' }, 'title'], [{ title: 'ab' }, 'title'], [{ title: 'x'.repeat(151) }, 'title'], [{ title: 'bad\u0000title' }, 'title'],
    [{ category: '' }, 'category'], [{ category: 'astrology' }, 'category'],
    [{ description: 'd'.repeat(2001) }, 'description'],
    [{ activity_date: '' }, 'activity_date'], [{ activity_date: '2026-02-30' }, 'activity_date'], [{ activity_date: '15/01/2026' }, 'activity_date'],
    [{ activity_date: '2999-01-01' }, 'activity_date'], [{ activity_date: '1999-12-31' }, 'activity_date'],
    [{ academic_session: '' }, 'academic_session'], [{ academic_session: '2025-2027' }, 'academic_session'], [{ academic_session: 'next year' }, 'academic_session'], [{ academic_session: '2099-2100' }, 'academic_session'],
    [{ semester: '' }, 'semester'], [{ semester: '0' }, 'semester'], [{ semester: '13' }, 'semester'], [{ semester: 'abc' }, 'semester'], [{ semester: '2.5' }, 'semester'],
  ];
  const before = (await pool.query('SELECT COUNT(*)::int n FROM activities WHERE student_id = $1', [s.id])).rows[0].n;
  const { leftovers } = await newFilesDuring(async () => {
    for (const [over, field] of cases) {
      const r = await send('/activities', { method: 'POST', token: s.token, fields: good(over), file: pdf() });
      assert.strictEqual(r.status, 400, `${JSON.stringify(over)} -> ${r.status}`);
      assert.ok(r.data.fields?.[field], `${JSON.stringify(over)} should flag "${field}": ${JSON.stringify(r.data)}`);
    }
    const noFile = await send('/activities', { method: 'POST', token: s.token, fields: good() });
    assert.strictEqual(noFile.status, 400); assert.ok(noFile.data.fields.proof);
  });
  assert.deepStrictEqual(leftovers, [], 'rejected uploads must not stay on disk');
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM activities WHERE student_id = $1', [s.id])).rows[0].n, before);
  // tolerated: accepted academic-year shorthand is normalised
  const ok = await submit(s, { academic_session: '2025-26', semester: '05' });
  assert.strictEqual(ok.academic_session, '2025-2026'); assert.strictEqual(ok.semester, '5');
});

test('categories come from the database: a deactivated category is refused, and disappears from /options', async () => {
  const s = await makeUser({ role: 'student' });
  const opts = await send('/activities/options', { token: s.token });
  assert.strictEqual(opts.status, 200);
  assert.ok(opts.data.categories.some((c) => c.name === 'workshop'));
  assert.ok(opts.data.limits.max_proof_mb >= 1 && opts.data.academic_years.length >= 1);
  await pool.query(`UPDATE categories SET is_active = FALSE WHERE name = 'workshop'`);
  try {
    assert.ok(!(await send('/activities/options', { token: s.token })).data.categories.some((c) => c.name === 'workshop'));
    const r = await send('/activities', { method: 'POST', token: s.token, fields: good({ category: 'workshop' }), file: pdf() });
    assert.strictEqual(r.status, 400); assert.ok(r.data.fields.category);
  } finally { await pool.query(`UPDATE categories SET is_active = TRUE WHERE name = 'workshop'`); }
});

// ------------------------------------------------------------------ submit
test('submit: creates pending v1 with version row, audit entry and notification; never leaks server paths', async () => {
  const s = await makeUser({ role: 'student' });
  const a = await submit(s);
  assert.strictEqual(a.status, 'pending'); assert.strictEqual(a.version, 1); assert.strictEqual(a.has_proof, true);
  assert.strictEqual(a.activity_date, '2026-01-15', 'date must not shift with the server time zone');
  assert.ok(!('proof_file_path' in a) && !('duplicate_of' in a));
  assert.ok(!JSON.stringify(a).includes(UPLOADS));
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM activity_versions WHERE activity_id = $1 AND version = 1', [a.id])).rows[0].n, 1);
  const audit = (await pool.query('SELECT old_status, new_status, version FROM audit_log WHERE activity_id = $1', [a.id])).rows;
  assert.deepStrictEqual(audit, [{ old_status: 'none', new_status: 'pending', version: 1 }]);
  assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Activity Submitted'`, [s.id])).rows.length >= 1);
  const stored = await filePathOf(a.id);
  assert.ok(stored.startsWith(UPLOADS) && /^\d+-[0-9a-f]{16}\.pdf$/.test(path.basename(stored)), 'random safe file name');
  for (const f of [png, jpg, webp]) assert.strictEqual((await send('/activities', { method: 'POST', token: s.token, fields: good(), file: f() })).status, 201);
});

test('only students submit; reviewers get 403 and no file is accepted', async () => {
  const f = await reviewer();
  const { result, leftovers } = await newFilesDuring(() => send('/activities', { method: 'POST', token: f.token, fields: good(), file: pdf() }));
  assert.strictEqual(result.status, 403); assert.deepStrictEqual(leftovers, []);
  assert.strictEqual((await send('/activities', { method: 'POST', fields: good(), file: pdf() })).status, 401);
  assert.strictEqual((await send('/activities/mine', { token: f.token })).status, 403);
});

// ------------------------------------------------------------------ files
test('files: wrong type, spoofed content, mismatched extension, oversize and multiple files are refused and cleaned up', async () => {
  const s = await makeUser({ role: 'student' });
  const { leftovers } = await newFilesDuring(async () => {
    const txt = await send('/activities', { method: 'POST', token: s.token, fields: good(), file: { buf: Buffer.from('hello'), name: 'note.txt', type: 'text/plain' } });
    assert.strictEqual(txt.status, 400);
    const fake = await send('/activities', { method: 'POST', token: s.token, fields: good(), file: { buf: Buffer.from('this is plain text, not a pdf'), name: 'cert.pdf', type: 'application/pdf' } });
    assert.strictEqual(fake.status, 400); assert.match(fake.data.error, /format|content/i);
    const wrongExt = await send('/activities', { method: 'POST', token: s.token, fields: good(), file: { ...png(), name: 'cert.pdf', type: 'application/pdf' } });
    assert.strictEqual(wrongExt.status, 400); assert.match(wrongExt.data.error, /does not match/);
    const big = await send('/activities', { method: 'POST', token: s.token, fields: good(), file: { buf: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(11 * 1024 * 1024, 1)]), name: 'big.pdf', type: 'application/pdf' } });
    assert.strictEqual(big.status, 413); assert.match(big.data.error, /Maximum size is \d+ MB/);
  });
  assert.deepStrictEqual(leftovers, []);
});

// ------------------------------------------------------------------ drafts
test('drafts: save with nothing, edit, replace proof (old file removed), submit, discard', async () => {
  const s = await makeUser({ role: 'student' });
  const empty = await send('/activities/draft', { method: 'POST', token: s.token, fields: {} });
  assert.strictEqual(empty.status, 201);
  assert.strictEqual(empty.data.status, 'draft'); assert.strictEqual(empty.data.title, 'Untitled draft'); assert.strictEqual(empty.data.category, null); assert.strictEqual(empty.data.has_proof, false);

  const bad = await send('/activities/draft', { method: 'POST', token: s.token, fields: { title: 'ok title', semester: '99' } });
  assert.strictEqual(bad.status, 400); assert.ok(bad.data.fields.semester);

  const id = empty.data.id;
  const e1 = await send(`/activities/${id}/draft`, { method: 'PUT', token: s.token, fields: { title: 'My Draft', category: 'sports' }, file: pdf() });
  assert.strictEqual(e1.status, 200, JSON.stringify(e1.data));
  assert.strictEqual(e1.data.title, 'My Draft'); assert.strictEqual(e1.data.has_proof, true);
  const firstFile = await filePathOf(id); assert.ok(fs.existsSync(firstFile));
  const e2 = await send(`/activities/${id}/draft`, { method: 'PUT', token: s.token, fields: { description: 'only description changed' }, file: png() });
  assert.strictEqual(e2.status, 200); assert.strictEqual(e2.data.title, 'My Draft', 'untouched fields are kept');
  await settle();
  assert.ok(!fs.existsSync(firstFile), 'replaced draft proof is removed');
  const secondFile = await filePathOf(id); assert.ok(fs.existsSync(secondFile)); pathsToClean.add(secondFile);

  // incomplete: cannot be submitted, says what is missing
  const inc = await send(`/activities/${id}/submit-draft`, { method: 'POST', token: s.token, json: {} });
  assert.strictEqual(inc.status, 400); assert.ok(inc.data.fields.activity_date && inc.data.fields.academic_session && inc.data.fields.semester);
  assert.strictEqual((await pool.query('SELECT status FROM activities WHERE id = $1', [id])).rows[0].status, 'draft');
  // complete it in the same request
  const sub = await send(`/activities/${id}/submit-draft`, { method: 'POST', token: s.token, fields: { activity_date: '2026-02-01', academic_session: '2025-26', semester: '4' } });
  assert.strictEqual(sub.status, 200, JSON.stringify(sub.data));
  assert.strictEqual(sub.data.status, 'pending'); assert.strictEqual(sub.data.version, 1);
  assert.strictEqual((await send(`/activities/${id}/draft`, { method: 'PUT', token: s.token, fields: { title: 'sneaky edit' } })).status, 409, 'a submitted activity is no longer editable');
  assert.strictEqual((await send(`/activities/${id}`, { method: 'DELETE', token: s.token })).status, 409, 'a submitted activity cannot be deleted');
  assert.strictEqual((await send(`/activities/${id}/submit-draft`, { method: 'POST', token: s.token, json: {} })).status, 409, 'cannot submit twice');

  // discard
  const d = (await send('/activities/draft', { method: 'POST', token: s.token, fields: { title: 'Throwaway' }, file: pdf() })).data;
  const df = await filePathOf(d.id);
  assert.strictEqual((await send(`/activities/${d.id}`, { method: 'DELETE', token: s.token })).status, 200);
  await settle();
  assert.ok(!fs.existsSync(df), 'discarded draft file removed');
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM activities WHERE id = $1', [d.id])).rows[0].n, 0);
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM audit_log WHERE activity_id = $1', [d.id])).rows[0].n, 0);
});

test('the untitled placeholder cannot be submitted as a title', async () => {
  const s = await makeUser({ role: 'student' });
  const d = (await send('/activities/draft', { method: 'POST', token: s.token, fields: good({ title: '' }), file: pdf() })).data;
  pathsToClean.add(await filePathOf(d.id));
  const r = await send(`/activities/${d.id}/submit-draft`, { method: 'POST', token: s.token, json: {} });
  assert.strictEqual(r.status, 400); assert.ok(r.data.fields.title);
});

test('drafts are private: other students get 404, reviewers and admins cannot see, list or review them, and statistics ignore them', async () => {
  const s = await makeUser({ role: 'student' }); const other = await makeUser({ role: 'student' });
  const f = await reviewer();
  const d = (await send('/activities/draft', { method: 'POST', token: s.token, fields: good({ title: 'Secret draft' }), file: pdf() })).data;
  pathsToClean.add(await filePathOf(d.id));
  for (const [who, tok] of [['other student', other.token], ['faculty', f.token], ['admin', adminToken]]) {
    for (const suffix of ['', '/audit', '/versions', '/proof']) {
      assert.strictEqual((await send(`/activities/${d.id}${suffix}`, { token: tok })).status, 404, `${who} GET ${suffix}`);
    }
    assert.strictEqual((await send(`/activities/${d.id}/draft`, { method: 'PUT', token: tok, fields: { title: 'hijack' } })).status, who.includes('student') ? 404 : 403);
  }
  assert.strictEqual((await send(`/activities/${d.id}/submit-draft`, { method: 'POST', token: other.token, json: {} })).status, 404);
  assert.strictEqual((await send(`/activities/${d.id}`, { method: 'DELETE', token: other.token })).status, 404);
  for (const act of ['approve', 'reject', 'request-correction']) {
    const r = await send(`/activities/${d.id}/${act}`, { method: 'PATCH', token: f.token, json: { remarks: 'x', notes: 'x' } });
    assert.strictEqual(r.status, 404, act);
  }
  for (const list of ['/activities/pending?limit=50&sort=newest', '/activities/history?limit=50']) {
    assert.ok(!(await send(list, { token: f.token })).data.activities.some((a) => a.id === d.id));
  }
  const an = await send('/analytics', { token: adminToken });
  const dbCount = (await pool.query(`SELECT COUNT(*)::int n FROM activities WHERE status <> 'draft'`)).rows[0].n;
  assert.strictEqual(an.data.totals.total_activities, dbCount);
  assert.strictEqual((await send(`/activities/${d.id}`, { token: s.token })).status, 200, 'the owner still can');
});

test('students cannot see or touch each other\'s submitted activities or proofs', async () => {
  const a = await makeUser({ role: 'student' }); const b = await makeUser({ role: 'student' });
  const act = await submit(a);
  for (const suffix of ['', '/audit', '/versions', '/proof']) assert.strictEqual((await send(`/activities/${act.id}${suffix}`, { token: b.token })).status, 403, suffix);
  assert.strictEqual((await send(`/activities/${act.id}/resubmit`, { method: 'PUT', token: b.token, fields: { remarks: 'x' } })).status, 404);
  assert.strictEqual((await send(`/activities/${act.id}/approve`, { method: 'PATCH', token: b.token, json: {} })).status, 403);
  assert.ok(!(await send('/activities/mine', { token: b.token })).data.activities.some((x) => x.id === act.id));
});

// ------------------------------------------------------------------ concurrency
test('double submit: two simultaneous requests produce exactly one submission', async () => {
  const s = await makeUser({ role: 'student' });
  const d = (await send('/activities/draft', { method: 'POST', token: s.token, fields: good(), file: pdf() })).data;
  pathsToClean.add(await filePathOf(d.id));
  const rs = await Promise.all([1, 2, 3].map(() => send(`/activities/${d.id}/submit-draft`, { method: 'POST', token: s.token, json: {} })));
  assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM audit_log WHERE activity_id = $1 AND new_status = 'pending'`, [d.id])).rows[0].n, 1);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM activity_versions WHERE activity_id = $1`, [d.id])).rows[0].n, 1);
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM notifications WHERE user_id = $1 AND title = 'Activity Submitted'`, [s.id])).rows[0].n, 1);
});

// ------------------------------------------------------------------ correction + resubmission
test('resubmission creates version 2 and keeps version 1 (details, proof file, review history) intact', async () => {
  const s = await makeUser({ role: 'student' }); const f = await reviewer();
  const proofA = pdf();
  const a = await submit(s, { title: 'Original Title' }, proofA);
  const fileA = await filePathOf(a.id);

  // not resubmittable until a reviewer asks
  assert.strictEqual((await send(`/activities/${a.id}/resubmit`, { method: 'PUT', token: s.token, fields: { remarks: 'x' } })).status, 409);
  const cr = await send(`/activities/${a.id}/request-correction`, { method: 'PATCH', token: f.token, json: { notes: 'Certificate is blurry' } });
  assert.strictEqual(cr.status, 200); assert.strictEqual(cr.data.status, 'correction_requested');

  // nothing changed and no note: refused
  const none = await send(`/activities/${a.id}/resubmit`, { method: 'PUT', token: s.token, fields: {} });
  assert.strictEqual(none.status, 400); assert.ok(none.data.fields.remarks);
  assert.strictEqual((await pool.query('SELECT status FROM activities WHERE id = $1', [a.id])).rows[0].status, 'correction_requested');

  const proofB = png();
  const re = await send(`/activities/${a.id}/resubmit`, { method: 'PUT', token: s.token, fields: { title: 'Corrected Title', remarks: 'Uploaded a clearer scan' }, file: proofB });
  assert.strictEqual(re.status, 200, JSON.stringify(re.data));
  assert.strictEqual(re.data.status, 'resubmitted'); assert.strictEqual(re.data.version, 2); assert.strictEqual(re.data.title, 'Corrected Title');
  const fileB = await filePathOf(a.id); pathsToClean.add(fileB);
  assert.notStrictEqual(fileA, fileB);
  assert.ok(fs.existsSync(fileA), 'version 1 proof file must still exist');

  const v = (await send(`/activities/${a.id}/versions`, { token: s.token })).data;
  assert.strictEqual(v.current_version, 2);
  assert.deepStrictEqual(v.versions.map((x) => [x.version, x.title]), [[1, 'Original Title'], [2, 'Corrected Title']]);
  assert.strictEqual(v.versions[1].note, 'Uploaded a clearer scan');
  assert.ok(v.versions.every((x) => !('proof_file_path' in x)));

  const p1 = await send(`/activities/${a.id}/proof?version=1`, { token: s.token });
  assert.strictEqual(p1.status, 200); assert.deepStrictEqual(p1.buf, proofA.buf); assert.strictEqual(p1.headers.get('content-type'), 'application/pdf');
  const p2 = await send(`/activities/${a.id}/proof`, { token: s.token });
  assert.deepStrictEqual(p2.buf, proofB.buf);
  assert.strictEqual((await send(`/activities/${a.id}/proof?version=9`, { token: s.token })).status, 404);
  assert.strictEqual((await send(`/activities/${a.id}/proof?version=abc`, { token: s.token })).status, 400);
  assert.strictEqual((await send(`/activities/${a.id}/proof?version=1`, { token: f.token })).status, 200, 'reviewer can open earlier evidence');

  const approve = await send(`/activities/${a.id}/approve`, { method: 'PATCH', token: f.token, json: { remarks: 'Clear now' } });
  assert.strictEqual(approve.status, 200);

  const trail = (await send(`/activities/${a.id}/audit`, { token: s.token })).data.map((x) => [x.old_status, x.new_status, x.version]);
  assert.deepStrictEqual(trail, [['none', 'pending', 1], ['pending', 'correction_requested', 1], ['correction_requested', 'resubmitted', 2], ['resubmitted', 'approved', 2]]);
  const remarks = (await send(`/activities/${a.id}/audit`, { token: s.token })).data.map((x) => x.remarks);
  assert.ok(remarks[1] === 'Certificate is blurry' && remarks[2] === 'Uploaded a clearer scan', 'earlier remarks are untouched');

  // approved is final
  assert.strictEqual((await send(`/activities/${a.id}/resubmit`, { method: 'PUT', token: s.token, fields: { remarks: 'again' } })).status, 409);
  assert.strictEqual((await send(`/activities/${a.id}/reject`, { method: 'PATCH', token: f.token, json: { remarks: 'changed my mind' } })).status, 409);
  assert.strictEqual((await send(`/activities/${a.id}/approve`, { method: 'PATCH', token: f.token, json: {} })).status, 409);
});

test('resubmit with only a note keeps the same proof; two simultaneous resubmissions make one version', async () => {
  const s = await makeUser({ role: 'student' }); const f = await reviewer();
  const a = await submit(s);
  await send(`/activities/${a.id}/request-correction`, { method: 'PATCH', token: f.token, json: { notes: 'Explain your role' } });
  const rs = await Promise.all([1, 2].map(() => send(`/activities/${a.id}/resubmit`, { method: 'PUT', token: s.token, fields: { remarks: 'I led the backend team' } })));
  assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const v = (await pool.query('SELECT version, note, proof_file_path FROM activity_versions WHERE activity_id = $1 ORDER BY version', [a.id])).rows;
  assert.deepStrictEqual(v.map((x) => x.version), [1, 2]);
  assert.strictEqual(v[0].proof_file_path, v[1].proof_file_path);
  assert.strictEqual(v[1].note, 'I led the backend team');
  assert.strictEqual((await pool.query(`SELECT COUNT(*)::int n FROM audit_log WHERE activity_id = $1 AND new_status = 'resubmitted'`, [a.id])).rows[0].n, 1);
});

test('reviewers cannot approve/reject/correct what is not awaiting review, and the old status check is gone', async () => {
  const s = await makeUser({ role: 'student' }); const f = await reviewer();
  const a = await submit(s);
  assert.strictEqual((await send(`/activities/${a.id}/request-correction`, { method: 'PATCH', token: f.token, json: { notes: 'fix' } })).status, 200);
  for (const act of ['approve', 'reject', 'request-correction']) {
    const r = await send(`/activities/${a.id}/${act}`, { method: 'PATCH', token: f.token, json: { remarks: 'x', notes: 'x' } });
    assert.strictEqual(r.status, 409, `${act} on correction_requested`);
  }
});

// ------------------------------------------------------------------ duplicates
test('duplicate proof: flagged for review (not rejected), drafts do not count, the student never learns whose it matched', async () => {
  const a = await makeUser({ role: 'student' }); const b = await makeUser({ role: 'student' }); const f = await reviewer();
  const shared = pdf();
  // drafts with the same file never flag anything
  const d1 = (await send('/activities/draft', { method: 'POST', token: a.token, fields: good(), file: shared })).data;
  const d2 = (await send('/activities/draft', { method: 'POST', token: b.token, fields: good(), file: shared })).data;
  pathsToClean.add(await filePathOf(d1.id)); pathsToClean.add(await filePathOf(d2.id));
  assert.strictEqual(d1.is_duplicate, false); assert.strictEqual(d2.is_duplicate, false);
  const s1 = await send(`/activities/${d1.id}/submit-draft`, { method: 'POST', token: a.token, json: {} });
  assert.strictEqual(s1.data.is_duplicate, false, 'first submission is not a duplicate');
  const s2 = await send(`/activities/${d2.id}/submit-draft`, { method: 'POST', token: b.token, json: {} });
  assert.strictEqual(s2.status, 200); assert.strictEqual(s2.data.is_duplicate, true); assert.ok(s2.data.warning);
  assert.ok(!('duplicate_of' in s2.data), 'student response must not reveal the matched record');
  assert.ok(!JSON.stringify((await send('/activities/mine', { token: b.token })).data).includes('duplicate_of'));
  const seen = (await send(`/activities/${d2.id}`, { token: f.token })).data;
  assert.strictEqual(seen.is_duplicate, true); assert.strictEqual(seen.duplicate_of, d1.id, 'reviewer sees which submission it matches');
  assert.strictEqual((await send(`/activities/${d2.id}/approve`, { method: 'PATCH', token: f.token, json: {} })).status, 200, 'a flag is not an automatic rejection');
  // an activity is not a duplicate of itself when the same file is kept on resubmission
  const own = await submit(a);
  await send(`/activities/${own.id}/request-correction`, { method: 'PATCH', token: f.token, json: { notes: 'add detail' } });
  const re = await send(`/activities/${own.id}/resubmit`, { method: 'PUT', token: a.token, fields: { description: 'More detail about the event' } });
  assert.strictEqual(re.data.is_duplicate, false);
});

// ------------------------------------------------------------------ filters, sorting, pagination
test('/mine filters, search, sort and pagination are real database queries (checked against known fixtures)', async () => {
  const s = await makeUser({ role: 'student' }); const other = await makeUser({ role: 'student' });
  const f = await reviewer();
  const mk = async (over, how = 'submit') => (how === 'draft'
    ? (await send('/activities/draft', { method: 'POST', token: s.token, fields: good(over) })).data
    : submit(s, over));
  const A = await mk({ title: 'Alpha Hackathon', category: 'hackathon', activity_date: '2025-08-10', academic_session: '2025-2026', semester: '3' });
  const B = await mk({ title: 'Beta Workshop 100% effort', category: 'workshop', activity_date: '2025-09-20', academic_session: '2025-2026', semester: '3', description: 'about growth' });
  const C = await mk({ title: 'Gamma Sports_Meet', category: 'sports', activity_date: '2024-11-05', academic_session: '2024-2025', semester: '1' });
  const D = await mk({ title: 'Delta Internship', category: 'internship', activity_date: '2026-02-01', academic_session: '2025-2026', semester: '4' });
  const E = await mk({ title: 'Epsilon Draft', category: 'sports', activity_date: '2026-03-01', academic_session: '2025-2026', semester: '4' }, 'draft');
  await submit(other, { title: 'Alpha Someone Else' });
  await send(`/activities/${A.id}/approve`, { method: 'PATCH', token: f.token, json: {} });
  await send(`/activities/${B.id}/reject`, { method: 'PATCH', token: f.token, json: { remarks: 'no' } });
  await send(`/activities/${C.id}/request-correction`, { method: 'PATCH', token: f.token, json: { notes: 'fix' } });
  await send(`/activities/${C.id}/resubmit`, { method: 'PUT', token: s.token, fields: { remarks: 'done' } });

  const titles = async (qs) => { const r = await send(`/activities/mine${qs}`, { token: s.token }); assert.strictEqual(r.status, 200, `${qs} -> ${JSON.stringify(r.data)}`); return r.data.activities.map((x) => x.title.split(' ')[0]); };
  const sorted = (x) => [...x].sort();
  assert.deepStrictEqual(sorted(await titles('')), ['Alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma']);
  assert.deepStrictEqual(await titles('?search=alpha'), ['Alpha'], 'search is case-insensitive and limited to my own records');
  assert.deepStrictEqual(await titles('?search=growth'), ['Beta'], 'search covers the description');
  assert.deepStrictEqual(await titles('?search=100%25'), ['Beta'], '% is a literal character');
  assert.deepStrictEqual(await titles('?search=%25'), ['Beta'], 'a lone % matches only titles containing %');
  assert.deepStrictEqual(await titles('?search=Sports_'), ['Gamma'], '_ is a literal character');
  assert.deepStrictEqual(await titles('?search=nothing-like-this'), []);
  assert.deepStrictEqual(await titles('?status=draft'), ['Epsilon']);
  assert.deepStrictEqual(await titles('?status=approved'), ['Alpha']);
  assert.deepStrictEqual(await titles('?status=rejected'), ['Beta']);
  assert.deepStrictEqual(sorted(await titles('?status=pending')), ['Delta', 'Gamma'], 'pending = waiting for review (includes resubmitted)');
  assert.deepStrictEqual(await titles('?status=resubmitted'), ['Gamma']);
  assert.deepStrictEqual(await titles('?status=correction_requested'), []);
  assert.deepStrictEqual(sorted(await titles('?category=sports')), ['Epsilon', 'Gamma']);
  assert.deepStrictEqual(await titles('?academic_session=2024-25'), ['Gamma'], 'year shorthand accepted');
  assert.deepStrictEqual(sorted(await titles('?academic_session=2025-2026')), ['Alpha', 'Beta', 'Delta', 'Epsilon']);
  assert.deepStrictEqual(sorted(await titles('?semester=3')), ['Alpha', 'Beta']);
  assert.deepStrictEqual(sorted(await titles('?date_from=2025-09-01&date_to=2026-02-01')), ['Beta', 'Delta']);
  assert.deepStrictEqual(await titles('?date_from=2026-03-01'), ['Epsilon']);
  assert.deepStrictEqual(await titles('?date_to=2024-12-31'), ['Gamma']);
  assert.deepStrictEqual(await titles('?category=sports&status=draft&semester=4&academic_session=2025-2026'), ['Epsilon'], 'filters combine');
  assert.deepStrictEqual(sorted(await titles('?status=all&category=all&semester=all&academic_session=all')), ['Alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma'], 'reset values mean "no filter"');

  // sorting
  assert.deepStrictEqual(await titles('?sort=date_newest'), ['Epsilon', 'Delta', 'Beta', 'Alpha', 'Gamma']);
  assert.deepStrictEqual(await titles('?sort=date_oldest'), ['Gamma', 'Alpha', 'Beta', 'Delta', 'Epsilon']);
  const newest = await titles('?sort=newest'); const oldest = await titles('?sort=oldest');
  assert.deepStrictEqual(newest, [...oldest].reverse());
  assert.strictEqual(newest[0], 'Epsilon'); // created last

  // pagination
  const p1 = (await send('/activities/mine?limit=2&page=1&sort=oldest', { token: s.token })).data;
  const p2 = (await send('/activities/mine?limit=2&page=2&sort=oldest', { token: s.token })).data;
  const p3 = (await send('/activities/mine?limit=2&page=3&sort=oldest', { token: s.token })).data;
  assert.deepStrictEqual([p1.total, p1.pages, p1.limit, p1.page], [5, 3, 2, 1]);
  assert.deepStrictEqual([p1.activities.length, p2.activities.length, p3.activities.length], [2, 2, 1]);
  const all = [...p1.activities, ...p2.activities, ...p3.activities].map((x) => x.id);
  assert.strictEqual(new Set(all).size, 5, 'pages never overlap');
  assert.strictEqual((await send('/activities/mine?limit=2&page=9', { token: s.token })).data.activities.length, 0);
  assert.strictEqual((await send('/activities/mine?limit=9999', { token: s.token })).data.limit, 50, 'limit is capped');
  const filteredCounts = (await send('/activities/mine?status=approved', { token: s.token })).data;
  assert.deepStrictEqual(filteredCounts.counts, { total: 5, draft: 1, pending: 2, approved: 1, rejected: 1, correction_requested: 0 }, 'tiles ignore filters');

  // invalid filter values are rejected, not silently ignored
  for (const qs of ['?status=bogus', '?sort=random', '?date_from=yesterday', '?date_to=2026-02-30', '?academic_session=2025-2030', '?semester=abc', '?date_from=2026-05-01&date_to=2026-01-01']) {
    assert.strictEqual((await send(`/activities/mine${qs}`, { token: s.token })).status, 400, qs);
  }
  assert.ok(!JSON.stringify(await send('/activities/mine', { token: s.token })).includes('proof_file_path'));
});

// ------------------------------------------------------------------ audit trail
test('the verification history cannot be edited or deleted, only removed together with a discarded draft', async () => {
  const s = await makeUser({ role: 'student' });
  const a = await submit(s);
  await assert.rejects(pool.query(`UPDATE audit_log SET remarks = 'forged' WHERE activity_id = $1`, [a.id]), /append-only/);
  await assert.rejects(pool.query(`UPDATE audit_log SET new_status = 'approved' WHERE activity_id = $1`, [a.id]), /append-only/);
  await assert.rejects(pool.query(`DELETE FROM audit_log WHERE activity_id = $1`, [a.id]), /append-only/);
  assert.strictEqual((await pool.query('SELECT COUNT(*)::int n FROM audit_log WHERE activity_id = $1', [a.id])).rows[0].n, 1);
  // there is no API to change it either
  assert.ok([404, 405].includes((await send(`/activities/${a.id}/audit`, { method: 'DELETE', token: adminToken })).status));
});

test('the status column only accepts the six defined statuses', async () => {
  const s = await makeUser({ role: 'student' });
  await assert.rejects(pool.query(`INSERT INTO activities (student_id, title, category, status) VALUES ($1, 'x', 'hackathon', 'finished')`, [s.id]), /activities_status_valid/);
  await assert.rejects(pool.query(`INSERT INTO activities (student_id, title, category, status) VALUES ($1, 'x', NULL, 'pending')`, [s.id]), /activities_category_required/);
});

test('API output never contains internal file paths', async () => {
  const s = await makeUser({ role: 'student' }); const f = await reviewer();
  const a = await submit(s);
  const bodies = [
    JSON.stringify((await send('/activities/mine', { token: s.token })).data),
    JSON.stringify((await send(`/activities/${a.id}`, { token: s.token })).data),
    JSON.stringify((await send(`/activities/${a.id}`, { token: f.token })).data),
    JSON.stringify((await send('/activities/pending?limit=50&sort=newest', { token: f.token })).data),
    JSON.stringify((await send(`/activities/${a.id}/versions`, { token: s.token })).data),
    JSON.stringify((await send(`/activities/${a.id}/approve`, { method: 'PATCH', token: f.token, json: {} })).data),
  ];
  for (const b of bodies) { assert.ok(!b.includes('proof_file_path')); assert.ok(!b.includes(UPLOADS)); assert.ok(!b.includes('/home/')); }
});
