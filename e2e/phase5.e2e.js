// Phase 5 browser test: student activity lifecycle. Needs PostgreSQL, backend :5001, frontend :3000.
//   node e2e/phase5.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const API = 'http://localhost:5001';
const PASSWORD = 'E2ePass@12345';
const tag = `e5${Date.now()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots5';
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

const makeFile = (name, kind = 'pdf') => {
  const p = path.join(out, `${tag}-${name}`);
  const head = kind === 'pdf' ? Buffer.from('%PDF-1.4\n%') : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(p, Buffer.concat([head, crypto.randomBytes(64)]));
  return p;
};
async function dbUser(role, email, department) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  return (await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active,department,enrollment_no)
     VALUES ($1,$2,$3,$4,'ACTIVE',true,$5,$6) RETURNING id`,
    [`E2E ${role} ${tag}`, email, hash, role, department, role === 'student' ? email.split('@')[0].toUpperCase() : null])).rows[0].id;
}
async function signIn(page, email) {
  // sign in through the portal that matches the account (the server also checks the role)
  const { rows: [who] } = await pool.query('SELECT role FROM users WHERE email = $1', [email]);
  await page.goto(`${WEB}/login/${who.role}`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
}
const toast = async (page, re) => { await page.waitForSelector('.toast'); return re.test(await page.textContent('.toast')); };

(async () => {
  const browser = await chromium.launch();
  const created = { ids: [] };
  try {
    const stuEmail = `${tag}.stu@college.test`; const facEmail = `${tag}.fac@college.test`;
    const stuId = await dbUser('student', stuEmail, 'Computer Science & Engineering');
    const facId = await dbUser('faculty', facEmail, 'Computer Science & Engineering');
    await pool.query(`INSERT INTO faculty_scopes (faculty_id, department) VALUES ($1, NULL)`, [facId]);
    created.ids.push(stuId, facId);

    const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    const stu = await ctx.newPage();
    await signIn(stu, stuEmail);
    await stu.waitForURL("**/dashboard");
    await stu.waitForSelector('[data-testid="activity-form"]');

    // ---- 1. validation messages, nothing submitted
    await stu.click('button:has-text("Submit for Verification")');
    const errs = await stu.locator('[role="alert"]').allTextContents();
    check('empty submit shows field errors (title, category, date, proof)',
      ['Title is required', 'Choose a category', 'Activity date is required', 'Attach a supporting proof'].every((m) => errs.some((e) => e.includes(m))), errs.join(' | '));
    check('empty submit stored nothing', (await pool.query('SELECT COUNT(*)::int n FROM activities WHERE student_id = $1', [stuId])).rows[0].n === 0);
    await stu.fill('#af-title', 'ab');
    await stu.click('button:has-text("Save as Draft")');
    check('too-short title blocked on draft too', (await stu.locator('#err-title').count()) === 1);
    await stu.fill('#af-date', '2999-01-01'); await stu.fill('#af-title', 'Inter College Hackathon');
    await stu.click('button:has-text("Save as Draft")');
    check('future date rejected', /future/.test((await stu.locator('#err-activity_date').textContent()) || ''));
    await stu.fill('#af-date', '');

    // ---- 2. save a draft with only a title
    await stu.click('button:has-text("Save as Draft")');
    check('draft saved with only a title', await toast(stu, /Draft saved/));
    await stu.waitForSelector('[data-testid^="edit-draft-"]');
    check('draft appears in list with Edit button', (await stu.locator('[data-testid^="edit-draft-"]').count()) === 1);
    check('draft has no Submit shortcut until it has a proof', (await stu.locator('[data-testid^="submit-draft-"]').count()) === 0);

    // ---- 3. edit the draft, complete it and submit
    await stu.click('[data-testid^="edit-draft-"]');
    check('form switches to edit mode', /Editing draft/.test(await stu.textContent('[data-testid="activity-form"]')));
    check('draft title is pre-filled', (await stu.inputValue('#af-title')) === 'Inter College Hackathon');
    await stu.selectOption('#af-category', 'hackathon');
    await stu.fill('#af-date', '2026-01-15'); await stu.selectOption('#af-sem', '3');
    await stu.fill('#af-desc', 'Built an attendance app with a three person team.');
    await stu.setInputFiles('[data-testid="proof-input"]', makeFile('a.pdf'));
    await stu.click('button:has-text("Save Changes")');
    check('draft updated', await toast(stu, /Draft saved/));
    await stu.waitForSelector('[data-testid^="submit-draft-"]');
    await stu.click('button:has-text("Submit for Verification")');
    await stu.waitForFunction(() => /submitted/i.test(document.querySelector('.toast')?.textContent || ''));
    const row = await pool.query(`SELECT status, version, activity_date::text d, academic_session, semester FROM activities WHERE student_id = $1`, [stuId]);
    check('draft became pending v1 with the entered date', row.rows.length === 1 && row.rows[0].status === 'pending' && row.rows[0].version === 1 && row.rows[0].d === '2026-01-15', JSON.stringify(row.rows));
    check('form returned to "new" mode', /Submit New Activity/.test(await stu.textContent('[data-testid="activity-form"]')));
    await stu.screenshot({ path: path.join(out, '1-dashboard-after-submit.png') });

    // ---- 4. duplicate proof is flagged, not rejected
    const dupFile = makeFile('dup.pdf');
    const fill = async (title, cat, file) => {
      await stu.fill('#af-title', title); await stu.selectOption('#af-category', cat); await stu.fill('#af-date', '2025-10-02'); await stu.selectOption('#af-sem', '3');
      await stu.setInputFiles('[data-testid="proof-input"]', file);
      await stu.click('button:has-text("Submit for Verification")');
      await stu.waitForFunction(() => /submitted/i.test(document.querySelector('.toast')?.textContent || ''));
      await stu.waitForTimeout(400);
    };
    await fill('Sports Day Winner', 'sports', dupFile);
    await stu.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 }).catch(() => {});
    await fill('Sports Day Winner (copy)', 'sports', dupFile);
    check('second submission with the same file is flagged', (await pool.query(`SELECT COUNT(*)::int n FROM activities WHERE student_id = $1 AND is_duplicate`, [stuId])).rows[0].n === 1);
    check('flagged item is still accepted as pending', (await pool.query(`SELECT status FROM activities WHERE student_id = $1 AND is_duplicate`, [stuId])).rows[0].status === 'pending');

    // ---- 5. filters run on the server (watch the real requests)
    for (let i = 1; i <= 10; i++) {
      await pool.query(`INSERT INTO activities (student_id,title,category,status,activity_date,academic_session,semester,version) VALUES ($1,$2,'workshop','approved',$3,'2024-2025','2',1)`,
        [stuId, `Bulk Workshop ${String(i).padStart(2, '0')}`, `2024-0${(i % 9) + 1}-10`]);
    }
    await stu.reload(); await stu.waitForSelector('[data-testid="pagination"]');
    const pag = await stu.textContent('[data-testid="pagination"]');
    check('13 records paginate into 2 pages of 10', /of 13/.test(pag) && /Page 1 of 2/.test(pag), pag);
    await stu.click('[data-testid="pagination"] button:has-text("Next")');
    await stu.waitForFunction(() => /Page 2 of 2/.test(document.querySelector('[data-testid="pagination"]')?.textContent || ''));
    await stu.waitForFunction(() => document.querySelectorAll('a[href^="/activity/"]').length === 3, null, { timeout: 5000 }).catch(() => {});
    check('page 2 shows the remaining 3', (await stu.locator('a[href^="/activity/"]').count()) === 3);
    await stu.click('[data-testid="pagination"] button:has-text("Previous")');

    const reqFor = (re) => stu.waitForRequest((r) => re.test(r.url()) && r.url().includes('/activities/mine'));
    let [rq] = await Promise.all([reqFor(/search=Bulk/), stu.fill('input[aria-label="Search records"]', 'Bulk')]);
    check('typing sends search= to the server', rq.url().includes('search=Bulk'));
    await stu.waitForFunction(() => /of 10/.test(document.querySelector('[data-testid="pagination"]')?.textContent || '') || document.querySelectorAll('a[href^="/activity/"]').length === 10);
    check('search narrows to 10 matching records', (await stu.locator('a[href^="/activity/"]').count()) === 10);
    [rq] = await Promise.all([reqFor(/academic_session=2024-2025/), stu.selectOption('select[aria-label="Academic year"]', '2024-2025')]);
    check('year filter sent to server', rq.url().includes('academic_session=2024-2025'));
    [rq] = await Promise.all([reqFor(/semester=2/), stu.selectOption('select[aria-label="Semester"]', '2')]);
    check('semester filter sent to server', rq.url().includes('semester=2'));
    [rq] = await Promise.all([reqFor(/sort=date_oldest/), stu.selectOption('select[aria-label="Sort order"]', 'date_oldest')]);
    check('sort sent to server', rq.url().includes('sort=date_oldest'));
    [rq] = await Promise.all([reqFor(/date_from=2024-05-01/), stu.fill('input[aria-label="Activity date from"]', '2024-05-01')]);
    check('date range sent to server', rq.url().includes('date_from=2024-05-01'));
    await stu.waitForTimeout(500);
    const dates = await stu.locator('a[href^="/activity/"]').count();
    check('date filter reduced the list', dates > 0 && dates < 10, String(dates));
    await stu.fill('input[aria-label="Search records"]', 'zzz-no-such');
    await stu.waitForSelector('text=No matching records');
    check('empty result shows a helpful message', true);
    await stu.screenshot({ path: path.join(out, '2-filters.png') });
    await stu.click('[data-testid="reset-filters"]');
    await stu.waitForSelector('[data-testid="pagination"]');
    check('Reset filters restores everything', /of 13/.test(await stu.textContent('[data-testid="pagination"]')) && (await stu.inputValue('input[aria-label="Search records"]')) === '');
    // status tab is server-side too
    [rq] = await Promise.all([reqFor(/status=approved/), stu.click('button:has-text("Verified")')]);
    check('status tab sent to server', rq.url().includes('status=approved'));
    await stu.click('[data-testid="reset-filters"]');

    // ---- 6. reviewer asks for a correction
    const actId = (await pool.query(`SELECT id FROM activities WHERE student_id = $1 AND title = 'Inter College Hackathon'`, [stuId])).rows[0].id;
    const fctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    const fac = await fctx.newPage();
    await signIn(fac, facEmail);
    await fac.waitForURL((u) => u.pathname === '/faculty');
    await fac.goto(`${WEB}/activity/${actId}`);
    await fac.click('button:has-text("Request Correction")');
    await fac.fill('textarea', 'The certificate scan is too dark to read.');
    await fac.click('button:has-text("Confirm Decision")');
    await fac.waitForSelector('text=Correction requested');
    check('reviewer requested a correction', (await pool.query('SELECT status FROM activities WHERE id = $1', [actId])).rows[0].status === 'correction_requested');

    // ---- 7. student resubmits: new version, old one kept
    await stu.goto(`${WEB}/activity/${actId}`);
    await stu.waitForSelector('text=Faculty Correction Instructions');
    await stu.click('button:has-text("Resubmit with Corrections")');
    await stu.click('button:has-text("Submit Corrections")');
    await stu.waitForSelector('[role="alert"], div:has-text("✕")');
    check('resubmitting with no change and no note is refused', (await pool.query('SELECT status FROM activities WHERE id = $1', [actId])).rows[0].status === 'correction_requested');
    await stu.fill('#rs-title', 'Inter College Hackathon (Winner)');
    await stu.fill('#rs-note', 'Re-scanned the certificate at higher resolution.');
    await stu.setInputFiles('[data-testid="resubmit-proof"]', makeFile('b.png', 'png'));
    await stu.click('button:has-text("Submit Corrections")');
    await stu.waitForSelector('text=now version 2');
    const vs = (await pool.query('SELECT version, title FROM activity_versions WHERE activity_id = $1 ORDER BY version', [actId])).rows;
    check('two versions are stored', vs.length === 2 && vs[0].title === 'Inter College Hackathon' && vs[1].title === 'Inter College Hackathon (Winner)', JSON.stringify(vs));
    check('history lists both versions', (await stu.locator('[data-testid="version-1"]').count()) === 1 && (await stu.locator('[data-testid="version-2"]').count()) === 1);
    check('note shown in history', /clearer|higher resolution/.test(await stu.textContent('[data-testid="version-2"]')));
    const bytes = await stu.evaluate(async ({ api, id }) => {
      const t = localStorage.getItem('token');
      const r = await fetch(`${api}/activities/${id}/proof?version=1`, { headers: { Authorization: `Bearer ${t}` } });
      return { status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength };
    }, { api: API, id: actId });
    check('version 1 proof is still downloadable and is a PDF', bytes.status === 200 && bytes.type === 'application/pdf' && bytes.size > 20, JSON.stringify(bytes));
    const tl = await stu.textContent('text=Verification Timeline & Audit Trail >> xpath=..');
    check('timeline shows version tags', /v1/.test(tl) && /v2/.test(tl));
    await stu.screenshot({ path: path.join(out, '3-versions.png'), fullPage: true });

    // ---- 8. reviewer approves; it counts as verified
    await fac.goto(`${WEB}/activity/${actId}`);
    await fac.click('button:has-text("Approve")');
    await fac.click('button:has-text("Confirm Decision")');
    await fac.waitForSelector('text=approved');
    await stu.goto(`${WEB}/dashboard`);
    await stu.waitForSelector('[data-testid="pagination"]');
    await stu.goto(`${WEB}/activity/${actId}`);
    check('no resubmit button once approved', (await stu.locator('button:has-text("Resubmit")').count()) === 0);

    // ---- 9. discard a draft (two-step confirm)
    await stu.goto(`${WEB}/dashboard`);
    await stu.fill('#af-title', 'Draft to delete');
    await stu.click('button:has-text("Save as Draft")');
    await stu.waitForSelector('[data-testid^="edit-draft-"]');
    await stu.click('[data-testid^="edit-draft-"]');
    await stu.click('text=Discard this draft');
    await stu.click('button:has-text("Yes, delete")');
    await stu.waitForFunction(() => /discarded/i.test(document.querySelector('.toast')?.textContent || ''));
    check('discarded draft is gone from the database', (await pool.query(`SELECT COUNT(*)::int n FROM activities WHERE student_id = $1 AND title = 'Draft to delete'`, [stuId])).rows[0].n === 0);

    // ---- 10. phone layout
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mob = await mctx.newPage();
    await signIn(mob, stuEmail);
    await mob.waitForURL('**/dashboard');
    await mob.waitForSelector('[data-testid="filter-bar"]');
    check('phone width: no horizontal scroll on dashboard', !(await mob.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
    await mob.goto(`${WEB}/activity/${actId}`);
    await mob.waitForSelector('[data-testid="version-history"]');
    console.log('OFFENDERS', JSON.stringify(await mob.evaluate(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 1).slice(0, 8).map((e) => e.tagName + '.' + String(e.className).slice(0, 80) + ' r=' + Math.round(e.getBoundingClientRect().right)); })));
    check('phone width: no horizontal scroll on activity page', !(await mob.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
    await mob.screenshot({ path: path.join(out, '4-mobile-activity.png'), fullPage: true });
  } catch (e) {
    console.error('E2E ERROR', e.message.split('\n')[0]);
    try { for (const [i, pg] of browser.contexts().flatMap((c) => c.pages()).entries()) { await pg.screenshot({ path: path.join(out, `fail-${i}.png`) }); console.error('PAGE', i, pg.url(), (await pg.locator('[role="alert"], .toast, .text-red-600').allTextContents()).join(' | ').slice(0, 300)); } } catch (_) {}
    results.push({ name: 'script completed', ok: false });
  } finally {
    await browser.close();
    const files = (await pool.query(`SELECT proof_file_path p FROM activity_versions WHERE activity_id IN (SELECT id FROM activities WHERE student_id = ANY($1)) UNION SELECT proof_file_path FROM activities WHERE student_id = ANY($1)`, [created.ids])).rows;
    for (const f of files) if (f.p) fs.rmSync(f.p, { force: true });
    await pool.query('DELETE FROM activities WHERE student_id = ANY($1)', [created.ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [created.ids]);
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
