// Phase 12 tests: analytics filters, new aggregates, faculty scope, CSV / PDF exports match the filters.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');
const app = require('../src/server');
const { initSchema } = require('../src/models/schema');
const { rateLimit } = require('../src/middleware/rateLimit');
const { setScope } = require('../src/utils/scope');
const { parseCsv } = require('../src/utils/csv');

const PASSWORD = 'TestPass@12345';
const P = `p12${Date.now()}`;
const DEPT_A = `Dept A ${P}`; const DEPT_B = `Dept B ${P}`;
let server; let base; let seq = 0; let admin; let facA; let facAll; let studentA; let studentB;
const ids = {};

async function send(p, { token } = {}) {
  const res = await fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = {}; try { data = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
  return { status: res.status, data, buf, headers: res.headers };
}
async function login(email) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  return (await r.json()).token;
}
async function makeUser(role, { department, programme } = {}) {
  const n = `${P}x${++seq}`; const email = `${n}@college.test`;
  const id = (await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active,department,programme,employee_id,enrollment_no)
     VALUES ($1,$2,$3,$4,'ACTIVE',TRUE,$5,$6,$7,$8) RETURNING id`,
    [`User ${n}`, email, await bcrypt.hash(PASSWORD, 4), role, department || null, programme || null, role === 'faculty' ? n.toUpperCase() : null, role === 'student' ? n.toUpperCase() : null])).rows[0].id;
  return { id, email, token: await login(email), name: `User ${n}` };
}
const act = (student, o) => pool.query(
  `INSERT INTO activities (student_id,title,category,status,academic_session,semester,created_at,reviewer_id,is_duplicate,file_hash,review_remarks)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
  [student.id, o.title, o.category, o.status, o.session, o.semester, o.at, o.reviewer || null, !!o.dup, o.hash || null, o.remarks || null]).then((r) => r.rows[0].id);
const an = (qs = '', u = admin) => send(`/analytics${qs ? `?${qs}` : ''}`, { token: u.token });

test.before(async () => {
  await initSchema();
  await new Promise((r) => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  admin = await makeUser('admin');
  facA = await makeUser('faculty'); await setScope(pool, facA.id, { all: false, departments: [DEPT_A] }, null);
  facAll = await makeUser('faculty'); await setScope(pool, facAll.id, { all: false, departments: [DEPT_A, DEPT_B] }, null);
  studentA = await makeUser('student', { department: DEPT_A, programme: `Prog1 ${P}` });
  studentB = await makeUser('student', { department: DEPT_B, programme: `Prog2 ${P}` });
  admin = { ...admin }; // admin sees the whole database, so admin tests always filter by this run's department
  ids.a1 = await act(studentA, { title: 'Hack A1', category: 'hackathon', status: 'approved', session: '2024-2025', semester: '3', at: '2025-01-10 10:00', reviewer: facA.id, hash: 'h1' });
  ids.a2 = await act(studentA, { title: '=HYPERLINK("http://x","click"),"quoted"', category: 'workshop', status: 'pending', session: '2024-2025', semester: 'Semester 3', at: '2025-02-20 09:00' });
  ids.a3 = await act(studentA, { title: 'Sports A3', category: 'sports', status: 'rejected', session: '2025-2026', semester: '5', at: '2025-08-05 12:00', reviewer: facA.id, remarks: 'Not valid' });
  ids.a4 = await act(studentA, { title: 'Cert A4', category: 'certification', status: 'resubmitted', session: '2025-2026', semester: '5', at: '2025-09-30 23:59:59', dup: true, hash: 'h1' });
  ids.a5 = await act(studentA, { title: 'Draft A5', category: 'hackathon', status: 'draft', session: '2025-2026', semester: '5', at: '2025-09-01 10:00' });
  ids.b1 = await act(studentB, { title: 'Hack B1', category: 'hackathon', status: 'approved', session: '2025-2026', semester: '5', at: '2025-09-15 10:00', reviewer: facAll.id });
  ids.b2 = await act(studentB, { title: 'Corr B2', category: 'workshop', status: 'correction_requested', session: '2025-2026', semester: '7', at: '2025-10-01 00:00:00', reviewer: facAll.id });
});
test.beforeEach(() => rateLimit.resetAll());
test.after(async () => {
  const u = (await pool.query(`SELECT id FROM users WHERE email LIKE $1`, [`${P}%`])).rows.map((r) => r.id);
  await pool.query('DELETE FROM activities WHERE student_id = ANY($1)', [u]);
  await pool.query('DELETE FROM faculty_scopes WHERE faculty_id = ANY($1)', [u]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [u]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

const both = `department=${encodeURIComponent(DEPT_A)}`;
const totalOf = async (qs, u) => (await an(qs, u)).data.totals;

test('access: only faculty and admin; students and signed-out users are refused', async () => {
  for (const p of ['/analytics', '/analytics/options', '/analytics/export/csv', '/analytics/export/pdf']) {
    assert.strictEqual((await send(p, { token: studentA.token })).status, 403, p);
    assert.strictEqual((await send(p)).status, 401, p);
  }
});

test('bad filters are a clear 400 on the view and both exports (never a 500)', async () => {
  const bad = ['date_from=2025-13-01', 'date_to=2025-02-30', 'date_from=yesterday', 'date_from=2025-05-01&date_to=2025-04-01', 'semester=0', 'semester=13', 'semester=abc',
    'status=draft', 'status=bogus', 'academic_session=2025-2027', 'academic_session=abc', "category=a'b", `department=${'x'.repeat(101)}`];
  for (const qs of bad) for (const p of ['/analytics', '/analytics/export/csv', '/analytics/export/pdf']) {
    const r = await send(`${p}?${qs}`, { token: admin.token });
    assert.strictEqual(r.status, 400, `${p}?${qs} -> ${r.status}`);
    assert.ok(r.data.error);
  }
  assert.strictEqual((await send('/analytics/export/csv?report=nope', { token: admin.token })).status, 400);
  assert.strictEqual((await send('/analytics/export/pdf?report=nope', { token: admin.token })).status, 400);
  assert.strictEqual((await send('/analytics?academic_session=2024-25&department=' + encodeURIComponent(DEPT_A), { token: admin.token })).status, 200, '"2024-25" is accepted as 2024-2025');
});

test('every filter narrows the numbers exactly; drafts are never counted', async () => {
  const dep = `department=${encodeURIComponent(DEPT_A)}`;
  assert.strictEqual((await totalOf(dep)).total_activities, 4, 'department A has 4 non-draft submissions');
  assert.strictEqual((await totalOf(`${dep}&status=approved`)).total_activities, 1);
  assert.strictEqual((await totalOf(`${dep}&status=pending`)).total_activities, 2, 'pending includes resubmitted');
  assert.strictEqual((await totalOf(`${dep}&status=rejected`)).total_activities, 1);
  assert.strictEqual((await totalOf(`${dep}&category=hackathon`)).total_activities, 1, 'the hackathon draft is excluded');
  assert.strictEqual((await totalOf(`${dep}&category=HACKATHON`)).total_activities, 1);
  assert.strictEqual((await totalOf(`${dep}&academic_session=2024-2025`)).total_activities, 2);
  assert.strictEqual((await totalOf(`${dep}&semester=3`)).total_activities, 2, '"3" and the older "Semester 3" are the same semester');
  assert.strictEqual((await totalOf(`${dep}&semester=5`)).total_activities, 2);
  assert.strictEqual((await totalOf(`programme=${encodeURIComponent(`Prog2 ${P}`)}`)).total_activities, 2);
  assert.strictEqual((await totalOf(`${dep}&date_from=2025-02-20&date_to=2025-02-20`)).total_activities, 1, 'a one-day range includes that whole day');
  assert.strictEqual((await totalOf(`${dep}&date_from=2025-09-30&date_to=2025-09-30`)).total_activities, 1, '23:59:59 is still the 30th');
  assert.strictEqual((await totalOf(`${dep}&date_from=2025-10-01`)).total_activities, 0, 'midnight on the 1st is not the 30th');
  const depB = `department=${encodeURIComponent(DEPT_B)}`;
  assert.strictEqual((await totalOf(`${depB}&date_to=2025-09-30`)).total_activities, 1, 'a submission at 00:00 on the 1st is after an end date of the 30th');
  assert.strictEqual((await totalOf(`${depB}&date_to=2025-10-01`)).total_activities, 2, 'and is included when the end date is the 1st');
  assert.strictEqual((await totalOf(`${dep}&semester=5&status=pending&academic_session=2025-2026&date_from=2025-09-01&date_to=2025-09-30`)).total_activities, 1, 'filters combine');
  assert.strictEqual((await totalOf(`${dep}&category=sports&status=approved`)).total_activities, 0);
});

test('aggregates add up and describe the same rows', async () => {
  const d = (await an(`department=${encodeURIComponent(DEPT_A)}`)).data;
  const t = d.totals;
  assert.deepStrictEqual([t.total_activities, t.approved, t.pending, t.rejected, t.correction_requested, t.total_students, t.drafts], [4, 1, 2, 1, 0, 1, 0]);
  assert.strictEqual(d.by_status.reduce((a, r) => a + r.count, 0), 4);
  assert.strictEqual(d.by_category.reduce((a, r) => a + r.count, 0), 4);
  assert.strictEqual(d.flagged_duplicates, 1);
  assert.deepStrictEqual(d.by_semester.map((r) => [r.semester, r.total, r.approved, r.pending, r.rejected]), [[3, 2, 1, 1, 0], [5, 2, 0, 1, 1]]);
  assert.deepStrictEqual(d.by_academic_year.map((r) => [r.academic_session, r.total, r.students]), [['2024-2025', 2, 1], ['2025-2026', 2, 1]]);
  assert.deepStrictEqual(d.by_month.map((m) => [m.month, m.count]), [['Jan 2025', 1], ['Feb 2025', 1], ['Aug 2025', 1], ['Sep 2025', 1]]);
  assert.deepStrictEqual(d.pending_by_month.map((m) => [m.month, m.count]), [['Feb 2025', 1], ['Sep 2025', 1]]);
  assert.deepStrictEqual(d.by_department.map((r) => [r.department, r.count, r.students]), [[DEPT_A, 4, 1]]);
  assert.deepStrictEqual(d.filters, { department: DEPT_A });
  const empty = (await an(`${both}&category=publication`)).data;
  assert.strictEqual(empty.totals.total_activities, 0);
  for (const k of ['by_status', 'by_category', 'by_department', 'by_semester', 'by_academic_year', 'by_month', 'pending_by_month', 'faculty_workload']) assert.deepStrictEqual(empty[k], [], k);
});

test('faculty workload: admin sees every reviewer, a faculty member only their own row', async () => {
  const adm = (await an(`${both}`)).data.faculty_workload;
  assert.deepStrictEqual(adm.map((w) => [w.faculty_id, w.total, w.approved, w.rejected]), [[facA.id, 2, 1, 1]]);
  const ab = (await an(`department=${encodeURIComponent(DEPT_B)}`)).data.faculty_workload;
  assert.deepStrictEqual(ab.map((w) => [w.faculty_id, w.total, w.approved, w.correction_requested]), [[facAll.id, 2, 1, 1]]);
  // facAll's scope covers both departments but must only see their own reviews
  const own = (await an(`${both}`, facAll)).data.faculty_workload;
  assert.deepStrictEqual(own, [], 'facAll reviewed nothing in department A, and must not see facA\'s row');
  const ownB = (await an(`department=${encodeURIComponent(DEPT_B)}`, facAll)).data.faculty_workload;
  assert.deepStrictEqual(ownB.map((w) => w.faculty_id), [facAll.id]);
});

test('faculty scope: every aggregate, option list and export is limited to their departments', async () => {
  const d = (await an('', facA)).data;
  assert.strictEqual(d.totals.total_activities, 4);
  assert.deepStrictEqual(d.by_department.map((r) => r.department), [DEPT_A]);
  assert.strictEqual((await an(`department=${encodeURIComponent(DEPT_B)}`, facA)).data.totals.total_activities, 0, 'asking for another department returns nothing');
  const wide = (await an('', facAll)).data;
  assert.strictEqual(wide.totals.total_activities, 6);
  const opt = (await send('/analytics/options', { token: facA.token })).data;
  assert.deepStrictEqual(opt.departments, [DEPT_A]);
  assert.deepStrictEqual(opt.programmes, [`Prog1 ${P}`]);
  assert.deepStrictEqual(opt.scope, { all: false, departments: [DEPT_A] });
  const csv = parseCsv((await send('/analytics/export/csv', { token: facA.token })).buf.toString('utf8')).records;
  assert.strictEqual(csv.length - 1, 4, 'CSV has only department A rows');
  assert.ok(!csv.some((r) => r.fields.includes(studentB.email)));
  const pdfText = await pdfToText((await send('/analytics/export/pdf?report=department', { token: facA.token })).buf);
  assert.ok(pdfText.includes(DEPT_A) && !pdfText.includes(DEPT_B));
});

test('filter options come from the database', async () => {
  const o = (await send('/analytics/options', { token: admin.token })).data;
  assert.ok(o.departments.includes(DEPT_A) && o.departments.includes(DEPT_B));
  assert.ok(o.programmes.includes(`Prog1 ${P}`));
  assert.ok(o.academic_years.includes('2024-2025') && o.academic_years.includes('2025-2026'));
  assert.ok([3, 5, 7].every((s) => o.semesters.includes(s)));
  assert.ok(Array.isArray(o.categories) && o.categories.every((c) => c.name && c.display_name));
  assert.deepStrictEqual(o.statuses, ['approved', 'pending', 'rejected', 'correction_requested']);
  assert.strictEqual(o.scope, null);
});

test('CSV: the rows match the filters exactly, and cells cannot run as spreadsheet formulas', async () => {
  const r = await send(`/analytics/export/csv?${both}&status=pending`, { token: admin.token });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /SARP_activities_report_\d{4}-\d{2}-\d{2}\.csv/);
  const text = r.buf.toString('utf8');
  assert.strictEqual(text.charCodeAt(0), 0xfeff, 'UTF-8 BOM so Excel reads it correctly');
  const rows = parseCsv(text).records.map((x) => x.fields);
  assert.strictEqual(rows.length - 1, 2);
  assert.deepStrictEqual(rows.slice(1).map((x) => Number(x[0])).sort(), [ids.a2, ids.a4].sort());
  const head = rows[0];
  assert.ok(['Programme', 'Academic Year', 'Semester', 'SHA-256 Hash'].every((h) => head.includes(h)));
  const titleCell = rows.find((x) => Number(x[0]) === ids.a2)[head.indexOf('Title')];
  assert.strictEqual(titleCell, `'=HYPERLINK("http://x","click"),"quoted"`, 'formula neutralised; quotes and commas intact');
  const all = parseCsv((await send(`/analytics/export/csv?${both}`, { token: admin.token })).buf.toString('utf8')).records.length - 1;
  assert.strictEqual(all, (await an(both)).data.totals.total_activities, 'CSV row count equals the dashboard total');
  assert.ok(!parseCsv((await send(`/analytics/export/csv?${both}`, { token: admin.token })).buf.toString('utf8')).records.some((x) => x.fields.includes('Draft A5')), 'drafts are never exported');
  const none = parseCsv((await send(`/analytics/export/csv?${both}&category=publication`, { token: admin.token })).buf.toString('utf8')).records;
  assert.strictEqual(none.length, 1, 'an empty result still has the header row');
});

test('CSV summary reports match the dashboard numbers', async () => {
  const dep = parseCsv((await send(`/analytics/export/csv?report=department&department=${encodeURIComponent(DEPT_B)}`, { token: admin.token })).buf.toString('utf8')).records.map((x) => x.fields);
  assert.deepStrictEqual(dep[0], ['Department', 'Students', 'Submissions', 'Approved', 'Pending', 'Rejected', 'Correction requested', 'Approved share']);
  assert.deepStrictEqual(dep[1], [DEPT_B, '1', '2', '1', '0', '0', '1', '50%']);
  const sem = parseCsv((await send(`/analytics/export/csv?report=semester&${both}`, { token: admin.token })).buf.toString('utf8')).records.map((x) => x.fields);
  assert.deepStrictEqual(sem.slice(1), [['Semester 3', '1', '2', '1', '1', '0', '0', '50%'], ['Semester 5', '1', '2', '0', '1', '1', '0', '0%']]);
});

function pdfToText(buf) {
  const f = path.join(os.tmpdir(), `${P}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(f, buf);
  try { return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); } finally { fs.rmSync(f, { force: true }); }
}
const pdfAvailable = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('PDF reports: valid PDFs that print the filters and the same numbers', { skip: !pdfAvailable && 'pdftotext not installed' }, async () => {
  for (const [report, title] of [['institutional', 'Institutional Activity Report'], ['department', 'Department-wise Report'], ['semester', 'Semester-wise Report']]) {
    const r = await send(`/analytics/export/pdf?report=${report}&${both}&status=pending&date_from=2025-01-01`, { token: admin.token });
    assert.strictEqual(r.status, 200, report);
    assert.match(r.headers.get('content-type'), /application\/pdf/);
    assert.match(r.headers.get('content-disposition'), new RegExp(`SARP_${report}_report_\\d{4}-\\d{2}-\\d{2}\\.pdf`));
    assert.strictEqual(r.buf.subarray(0, 5).toString(), '%PDF-');
    const text = await pdfToText(r.buf);
    assert.ok(text.includes(title), `${report}: title`);
    assert.ok(text.includes('Filters applied'), `${report}: filters section heading`);
    assert.ok(text.includes(`Department: ${DEPT_A}`) && text.includes('Status: pending') && text.includes('Submitted from: 2025-01-01'), `${report}: filters are printed`);
    assert.ok(/Submissions\s*\n?\s*|2/.test(text));
  }
  const inst = await pdfToText((await send(`/analytics/export/pdf?${both}`, { token: admin.token })).buf);
  assert.ok(/Semester 3/.test(inst) && /Semester 5/.test(inst) && /2024-2025/.test(inst) && /2025-2026/.test(inst), 'semester and year tables are present');
  assert.ok(inst.includes(DEPT_A) && !inst.includes(DEPT_B), 'only the filtered department appears');
  assert.ok(/None \(all records in scope\)/.test(await pdfToText((await send('/analytics/export/pdf?semester=7', { token: admin.token })).buf)) === false, 'a filtered report does not claim "no filters"');
  const emptyText = await pdfToText((await send(`/analytics/export/pdf?${both}&category=publication`, { token: admin.token })).buf);
  assert.ok(/No submissions match the selected filters/.test(emptyText), 'empty state is explained');
  const dept = await pdfToText((await send(`/analytics/export/pdf?report=department&department=${encodeURIComponent(DEPT_B)}`, { token: admin.token })).buf);
  assert.ok(dept.includes('Category breakdown') && /hackathon/.test(dept) && /workshop/.test(dept));
});

test('a long report paginates and repeats nothing it should not', { skip: !pdfAvailable && 'pdftotext not installed' }, async () => {
  const many = [];
  for (let i = 0; i < 70; i++) many.push(pool.query(`INSERT INTO users (name,email,password_hash,role,status,is_active,department) VALUES ($1,$2,'x','student','ACTIVE',TRUE,$3)`, [`Bulk ${i}`, `${P}bulk${i}@college.test`, `Bulk Dept ${String(i).padStart(2, '0')} ${P}`]));
  await Promise.all(many);
  const bulk = (await pool.query(`SELECT id, department FROM users WHERE email LIKE $1`, [`${P}bulk%`])).rows;
  for (const b of bulk) await pool.query(`INSERT INTO activities (student_id,title,category,status,academic_session,semester) VALUES ($1,'Bulk','sports','approved','2025-2026','1')`, [b.id]);
  const r = await send(`/analytics/export/pdf?report=department&semester=1`, { token: admin.token });
  const text = await pdfToText(r.buf);
  const pages = (text.match(/\f/g) || []).length;
  assert.ok(pages >= 2, `report spans ${pages} pages`);
  for (const b of bulk) assert.ok(text.includes(b.department), `${b.department} appears`);
  assert.ok((text.match(/Participation by department/g) || []).length === 1);
  assert.ok((text.match(/Page \d+ of \d+/g) || []).length === pages, 'every page has a footer');
  await pool.query('DELETE FROM activities WHERE student_id = ANY($1)', [bulk.map((b) => b.id)]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [bulk.map((b) => b.id)]);
});
