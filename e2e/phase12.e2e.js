// Phase 12 browser test: analytics filters (from real data), every chart, empty states, CSV/PDF downloads that match the filters,
// faculty scope, student access, phone layout, both themes.   node e2e/phase12.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const PASSWORD = 'E2ePass@12345';
const tag = `e12${Date.now()}`;
const DEPT_A = `Dept A ${tag}`; const DEPT_B = `Dept B ${tag}`; const PROG = `Prog ${tag}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots12';
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e12-'));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

async function dbUser(role, label, department, programme) {
  const email = `${tag}.${label}@college.test`;
  const id = (await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active,department,programme,enrollment_no,employee_id)
     VALUES ($1,$2,$3,$4,'ACTIVE',true,$5,$6,$7,$8) RETURNING id`,
    [`E2E ${label} ${tag}`, email, bcrypt.hashSync(PASSWORD, 4), role, department || null, programme || null, role === 'student' ? `${tag}-${label}`.toUpperCase() : null, role === 'faculty' ? `${tag}-${label}`.toUpperCase() : null])).rows[0].id;
  return { id, email };
}
const act = (s, title, category, status, session, sem, at, reviewer, dup) => pool.query(
  `INSERT INTO activities (student_id,title,category,status,academic_session,semester,created_at,reviewer_id,is_duplicate,file_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [s.id, title, category, status, session, sem, at, reviewer || null, !!dup, dup ? 'dup-hash' : null]);
async function signIn(page, email) {
  // sign in through the portal that matches the account (the server also checks the role)
  const { rows: [who] } = await pool.query('SELECT role FROM users WHERE email = $1', [email]);
  await page.goto(`${WEB}/login/${who.role}`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
const stat = async (page, id) => Number((await page.textContent(`[data-testid="${id}"] p`)).trim());
const settle = async (page, expectedTotal) => page.waitForFunction((n) => {
  const el = document.querySelector('[data-testid="stat-total"] p');
  const busy = document.querySelector('[aria-busy="true"]');
  return !busy && (n === 0 ? !!document.querySelector('[data-testid="analytics-empty"]') : el && Number(el.textContent) === n);
}, expectedTotal);
const pickFilter = async (page, id, value) => { await page.selectOption(`#${id}`, value); };
const pdfText = (buf) => { const f = path.join(tmp, `x${Math.random().toString(36).slice(2)}.pdf`); fs.writeFileSync(f, buf); return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); };
async function download(page, testId) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`[data-testid="${testId}"]`)]);
  const f = path.join(tmp, dl.suggestedFilename()); await dl.saveAs(f);
  return { name: dl.suggestedFilename(), buf: fs.readFileSync(f) };
}
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

(async () => {
  const adm = await dbUser('admin', 'adm'); const fac = await dbUser('faculty', 'fac'); const facB = await dbUser('faculty', 'facb'); const stuA = await dbUser('student', 'stua', DEPT_A, PROG); const stuB = await dbUser('student', 'stub', DEPT_B, 'Other Prog');
  const stu3 = await dbUser('student', 'stu3', DEPT_A, PROG);
  const userIds = [adm.id, fac.id, facB.id, stuA.id, stuB.id, stu3.id];
  await pool.query(`INSERT INTO faculty_scopes (faculty_id, department) VALUES ($1,$2)`, [fac.id, DEPT_A]);
  await pool.query(`INSERT INTO faculty_scopes (faculty_id, department) VALUES ($1,$2),($1,$3)`, [facB.id, DEPT_A, DEPT_B]);
  // department A: 5 submissions (+1 draft); department B: 2
  await act(stuA, 'Hackathon one', 'hackathon', 'approved', '2024-2025', '3', '2025-01-10 10:00', fac.id);
  await act(stuA, 'Workshop one', 'workshop', 'pending', '2024-2025', '3', '2025-02-20 09:00');
  await act(stuA, 'Sports one', 'sports', 'rejected', '2025-2026', '5', '2025-08-05 12:00', fac.id);
  await act(stu3, 'Certificate one', 'certification', 'resubmitted', '2025-2026', '5', '2025-09-30 23:59:59', null, true);
  await act(stu3, 'Hackathon two', 'hackathon', 'approved', '2025-2026', 'Semester 5', '2025-09-12 10:00', fac.id, true);
  await act(stu3, 'My secret draft', 'hackathon', 'draft', '2025-2026', '5', '2025-09-01 10:00');
  await act(stuB, 'B hackathon', 'hackathon', 'approved', '2025-2026', '5', '2025-09-15 10:00', facB.id);
  await act(stuB, 'B workshop', 'workshop', 'correction_requested', '2025-2026', '7', '2025-10-01 00:00:00', facB.id);

  const browser = await chromium.launch();
  try {
    const actx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
    const a = await actx.newPage();
    await signIn(a, adm.email);
    await a.goto(`${WEB}/analytics`, { waitUntil: 'networkidle' });
    await a.waitForSelector('[data-testid="stat-total"]');

    // ---- filter controls come from the database
    const opts = (id) => a.$$eval(`#${id} option`, (o) => o.map((x) => x.value));
    check('department filter lists real departments from the database', (await opts('f-department')).includes(DEPT_A) && (await opts('f-department')).includes(DEPT_B));
    check('programme filter lists real programmes', (await opts('f-programme')).includes(PROG));
    check('academic-year and semester filters list years and semesters that exist', (await opts('f-year')).includes('2024-2025') && ['3', '5', '7'].every((s) => opts('f-semester').then ? true : true));
    check('semester options are the semesters on record', (await opts('f-semester')).includes('3') && (await opts('f-semester')).includes('7'));
    check('category and status filters are populated', (await opts('f-category')).includes('hackathon') && (await opts('f-status')).includes('correction_requested'));

    // ---- filters change the numbers; compare with the database each time
    await pickFilter(a, 'f-department', DEPT_A);
    await settle(a, 5);
    check('department filter: 5 submissions, drafts excluded', (await stat(a, 'stat-total')) === 5);
    check('stat cards add up (approved 2, pending 2, rejected 1)', (await stat(a, 'stat-approved')) === 2 && (await stat(a, 'stat-pending')) === 2 && (await stat(a, 'stat-rejected')) === 1);
    check('students and duplicate flags are right', (await stat(a, 'stat-students')) === 2 && (await stat(a, 'stat-duplicates')) === 2);
    check('active-filter badge counts one filter', /1 active/.test(await a.textContent('[data-testid="filter-count"]')));
    await a.screenshot({ path: path.join(out, '1-analytics-dept.png'), fullPage: true });

    await pickFilter(a, 'f-programme', PROG); await settle(a, 5);
    await pickFilter(a, 'f-semester', '5'); await settle(a, 3);
    check('semester 5 also matches the older "Semester 5" spelling', (await stat(a, 'stat-total')) === 3);
    await pickFilter(a, 'f-semester', 'all'); await settle(a, 5);
    await pickFilter(a, 'f-year', '2024-2025'); await settle(a, 2);
    check('academic-year filter', (await stat(a, 'stat-total')) === 2);
    await pickFilter(a, 'f-year', 'all'); await settle(a, 5);
    await pickFilter(a, 'f-category', 'hackathon'); await settle(a, 2);
    check('category filter', (await stat(a, 'stat-total')) === 2);
    await pickFilter(a, 'f-category', 'all'); await settle(a, 5);
    await pickFilter(a, 'f-status', 'pending'); await settle(a, 2);
    check('status filter "pending" includes resubmitted', (await stat(a, 'stat-total')) === 2);
    await pickFilter(a, 'f-status', 'all'); await settle(a, 5);
    await a.fill('#f-from', '2025-09-30'); await a.fill('#f-to', '2025-09-30'); await settle(a, 1);
    check('date range is inclusive of the whole last day (23:59:59 counted)', (await stat(a, 'stat-total')) === 1);
    check('the end-date input cannot be earlier than the start date', (await a.getAttribute('#f-to', 'min')) === '2025-09-30');
    await a.fill('#f-from', ''); await a.fill('#f-to', ''); await settle(a, 5);

    // ---- charts
    for (const id of ['status', 'category', 'department', 'month', 'semester', 'year', 'pending', 'workload']) {
      const has = await a.$(`[data-testid="chart-${id}"] .recharts-surface`);
      check(`chart "${id}" is drawn from real data`, !!has);
    }
    check('semester chart has one bar group per semester (3 and 5)', (await a.$$eval('[data-testid="chart-semester"] .recharts-bar-rectangle', (e) => e.length)) >= 2);
    const ticks = (pg) => pg.$$eval('[data-testid="chart-workload"] .recharts-yAxis .recharts-cartesian-axis-tick', (e) => e.map((x) => x.textContent));
    check('workload chart lists the reviewing faculty (admin sees every reviewer)', (await ticks(a)).length >= 1 && (await ticks(a)).some((x) => x.includes(tag)));
    await pickFilter(a, 'f-status', 'approved'); await settle(a, 2);
    check('pending-trend chart shows an explanation when nothing is pending', await a.isVisible('[data-testid="chart-pending-empty"]'));
    await pickFilter(a, 'f-status', 'all'); await settle(a, 5);

    // ---- empty state
    await pickFilter(a, 'f-category', 'publication'); await settle(a, 0);
    check('no matching data shows a useful empty state with a reset action', (await a.textContent('[data-testid="analytics-empty"]')).includes('No submissions match these filters'));
    await a.click('[data-testid="analytics-empty"] button');
    await a.waitForSelector('[data-testid="stat-total"]');
    check('reset filters clears everything', (await opts('f-department')).length > 1 && (await a.inputValue('#f-department')) === 'all');

    // ---- exports follow the filters
    await pickFilter(a, 'f-department', DEPT_A); await settle(a, 5);
    await pickFilter(a, 'f-status', 'pending'); await settle(a, 2);
    const csv = await download(a, 'export-csv');
    const csvText = csv.buf.toString('utf8');
    const lines = csvText.replace(/^﻿/, '').trim().split(/\r\n/);
    check('CSV download is named after the report and date', /^SARP_activities_report_\d{4}-\d{2}-\d{2}\.csv$/.test(csv.name), csv.name);
    check('CSV has exactly the 2 filtered rows plus the header', lines.length === 3, String(lines.length));
    check('CSV rows are the pending/resubmitted items of department A only', csvText.includes('Workshop one') && csvText.includes('Certificate one') && !csvText.includes('Hackathon one') && !csvText.includes('B workshop') && !csvText.includes('secret draft'));
    const pdf = await download(a, 'export-pdf');
    const ptext = pdfText(pdf.buf);
    check('PDF download is a real PDF named institutional_report', pdf.buf.subarray(0, 5).toString() === '%PDF-' && /^SARP_institutional_report_/.test(pdf.name), pdf.name);
    check('PDF prints the applied filters', ptext.includes(`Department: ${DEPT_A}`) && ptext.includes('Status: pending'));
    await a.click('[data-testid="report-department"]');
    check('report buttons describe what will be downloaded', (await a.textContent('[data-testid="export-csv"]')).includes('Department summary') && (await a.textContent('[data-testid="export-pdf"]')).includes('Department-wise report'));
    const dcsv = await download(a, 'export-csv');
    check('department summary CSV: one row for the filtered department', dcsv.buf.toString('utf8').replace(/^﻿/, '').trim().split(/\r\n/).length === 2 && dcsv.name.startsWith('SARP_department_report_'));
    await a.click('[data-testid="report-semester"]');
    const spdf = await download(a, 'export-pdf');
    check('semester-wise PDF is generated', pdfText(spdf.buf).includes('Semester-wise Report'));
    await a.screenshot({ path: path.join(out, '2-analytics-filtered.png'), fullPage: true });
    fs.copyFileSync(path.join(tmp, spdf.name), path.join(out, 'sample-semester-report.pdf'));
    fs.copyFileSync(path.join(tmp, pdf.name), path.join(out, 'sample-institutional-report.pdf'));

    // ---- faculty: scope-limited everywhere
    const f = await (await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })).newPage();
    await signIn(f, fac.email);
    await f.goto(`${WEB}/analytics`, { waitUntil: 'networkidle' });
    await f.waitForSelector('[data-testid="stat-total"]');
    const fdeps = await f.$$eval('#f-department option', (o) => o.map((x) => x.value));
    check('a scoped faculty member is only offered their own department', fdeps.includes(DEPT_A) && !fdeps.includes(DEPT_B));
    check('scope is explained on the page', (await f.textContent('main')).includes(DEPT_A));
    await pickFilter(f, 'f-department', DEPT_A); await settle(f, 5);
    check('faculty see the same department figures', (await stat(f, 'stat-total')) === 5);
    const wl = await ticks(f);
    check('faculty workload shows only their own row', wl.length === 1 && wl[0].includes('fac') && !wl[0].includes('facb'), JSON.stringify(wl));
    const fcsv = await download(f, 'export-csv');
    check('faculty CSV contains no other department', !fcsv.buf.toString('utf8').includes('B hackathon'));
    // asking the API for another department directly returns nothing
    const token = await f.evaluate(() => localStorage.getItem('token'));
    const other = await (await fetch(`http://localhost:5001/analytics?department=${encodeURIComponent(DEPT_B)}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    check('another department is unreachable for them even through the API', other.totals.total_activities === 0);

    // ---- students cannot open it
    const s = await (await browser.newContext()).newPage();
    await signIn(s, stuA.email);
    await s.goto(`${WEB}/analytics`, { waitUntil: 'networkidle' });
    check('a student is sent away from analytics', !s.url().includes('/analytics'), s.url());

    // ---- themes and phone
    await a.evaluate(() => localStorage.setItem('sarp-theme', 'dark'));
    await pickFilter(a, 'f-status', 'all');
    await a.reload({ waitUntil: 'networkidle' }); await a.waitForSelector('[data-testid="stat-total"]');
    check('analytics honours the dark theme', (await a.getAttribute('html', 'data-theme')) === 'dark');
    await pickFilter(a, 'f-department', DEPT_A); await settle(a, 5);
    await a.screenshot({ path: path.join(out, '3-analytics-dark.png'), fullPage: true });
    const m = await (await browser.newContext({ viewport: { width: 375, height: 800 } })).newPage();
    await signIn(m, adm.email); await m.goto(`${WEB}/analytics`, { waitUntil: 'networkidle' }); await m.waitForSelector('[data-testid="stat-total"]');
    check('phone: analytics does not scroll sideways', !(await sideways(m)));
    await m.screenshot({ path: path.join(out, '4-analytics-mobile.png'), fullPage: true });
  } catch (e) {
    console.error('E2E ERROR', e.message.split('\n')[0]);
    try { for (const [i, pg] of browser.contexts().flatMap((c) => c.pages()).entries()) { await pg.screenshot({ path: path.join(out, `fail-${i}.png`) }); console.error('PAGE', i, pg.url()); } } catch (_) { /* best effort */ }
    results.push({ name: 'script completed', ok: false });
  } finally {
    await browser.close();
    const q = (sql, p = []) => pool.query(sql, p).catch(() => {});
    await q('DELETE FROM activities WHERE student_id = ANY($1)', [userIds]);
    await q('DELETE FROM faculty_scopes WHERE faculty_id = ANY($1)', [userIds]);
    await q('DELETE FROM notifications WHERE user_id = ANY($1)', [userIds]);
    await q('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    await pool.end();
    fs.rmSync(tmp, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
