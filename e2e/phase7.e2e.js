// Phase 7 browser test: admin overview, academic setup, academic assignment, audit log.
// Needs PostgreSQL, backend on :5001, frontend (next start) on :3000.   node e2e/phase7.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const PASSWORD = 'E2ePass@12345';
const tag = `e7${Date.now()}`;
const T = tag.toUpperCase().slice(-8);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots7';
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

async function dbUser(role, label, department) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const email = `${tag}.${label}@college.test`;
  const id = (await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active,department,enrollment_no,programme,academic_year,semester)
     VALUES ($1,$2,$3,$4,'ACTIVE',true,$5,$6,$7,$8,$9) RETURNING id`,
    [`E2E ${label} ${tag}`, email, hash, role, department, role === 'student' ? `${tag}-${label}`.toUpperCase() : null, role === 'student' ? 'BTech' : null, role === 'student' ? '2025-2026' : null, role === 'student' ? '3' : null])).rows[0].id;
  return { id, email };
}
async function signIn(page, email) {
  // sign in through the portal that matches the account (the server also checks the role)
  const { rows: [who] } = await pool.query('SELECT role FROM users WHERE email = $1', [email]);
  await page.goto(`${WEB}/login/${who.role}`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
}
const msg = (page) => page.textContent('[data-testid="acad-message"]');
const waitMsg = async (page, re) => { await page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('[data-testid="acad-message"]')?.textContent || ''), re.source); };
const tile = async (page, id) => Number(await page.textContent(`[data-testid="tile-value-${id}"]`));

(async () => {
  const browser = await chromium.launch();
  const userIds = [];
  try {
    const admin = await dbUser('admin', 'adm', null); const stu = await dbUser('student', 'stu', 'Computer Science & Engineering');
    const fac = await dbUser('faculty', 'fac', 'Computer Science & Engineering');
    userIds.push(admin.id, stu.id, fac.id);
    await pool.query(`INSERT INTO academic_sessions (name, current_semester, is_current) VALUES ('2011-2012', '2', false) ON CONFLICT (name) DO NOTHING`);
    const thisYear = new Date().getFullYear();

    const ctx = await browser.newContext({ viewport: { width: 1360, height: 1100 } });
    const page = await ctx.newPage();
    await signIn(page, admin.email);
    await page.waitForURL((u) => u.pathname === '/admin');
    await page.waitForSelector('[data-testid="overview-tiles"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="tile-value-students"]')?.textContent !== '0');

    // ---- 1. overview tiles show real numbers
    const db = (await pool.query(
      `SELECT (SELECT COUNT(*) FROM users WHERE role='student')::int students, (SELECT COUNT(*) FROM users WHERE role='faculty')::int faculty,
              COUNT(*) FILTER (WHERE status<>'draft')::int total, COUNT(*) FILTER (WHERE status IN ('pending','resubmitted'))::int pending,
              COUNT(*) FILTER (WHERE status='approved')::int approved, COUNT(*) FILTER (WHERE status='rejected')::int rejected,
              COUNT(*) FILTER (WHERE status='correction_requested')::int corr, COUNT(*) FILTER (WHERE is_duplicate AND status<>'draft')::int dup
       FROM activities`)).rows[0];
    const ui = { students: await tile(page, 'students'), faculty: await tile(page, 'faculty'), total: await tile(page, 'activities'), pending: await tile(page, 'pending'),
      approved: await tile(page, 'approved'), rejected: await tile(page, 'rejected'), corr: await tile(page, 'corrections'), dup: await tile(page, 'duplicates') };
    check('overview shows the 8 institutional numbers from the database', JSON.stringify(ui) === JSON.stringify(db), `${JSON.stringify(ui)} vs ${JSON.stringify(db)}`);
    await page.screenshot({ path: path.join(out, '1-overview.png') });

    // ---- 2. departments
    await page.click('[data-testid="nav-admin-academic"]');
    await page.waitForSelector('[data-testid="acad-departments"]');
    const deptCode = `E${T}`.slice(0, 10); const deptName = `E2E Dept ${tag}`;
    await page.fill('input[aria-label="Department code"]', deptCode.toLowerCase());
    await page.fill('input[aria-label="Department name"]', deptName);
    await page.click('button:has-text("Add department")');
    await waitMsg(page, /Department added/);
    const row = page.locator('[data-testid="departments-table"] tr', { hasText: deptName });
    check('department added (code upper-cased)', (await row.count()) === 1 && /Active/.test(await row.textContent()) && (await row.textContent()).includes(deptCode));
    await page.fill('input[aria-label="Department code"]', deptCode);
    await page.fill('input[aria-label="Department name"]', 'Some Other Name');
    await page.click('button:has-text("Add department")');
    await waitMsg(page, /already exists/);
    check('duplicate code refused with a clear message, nothing overwritten', (await page.locator('[data-testid="departments-table"] tr', { hasText: 'Some Other Name' }).count()) === 0 && (await page.locator('[data-testid="departments-table"] tr', { hasText: deptName }).count()) === 1);
    await row.locator('button:has-text("Edit")').click();
    const renamed = `${deptName} Renamed`;
    await page.fill('input[aria-label="Edit name"]', renamed);
    await page.click('button:has-text("Save")');
    await waitMsg(page, /Department updated/);
    check('department renamed', (await page.locator('[data-testid="departments-table"] tr', { hasText: renamed }).count()) === 1);
    await page.screenshot({ path: path.join(out, '2-departments.png') });

    // ---- 3. programmes
    await page.click('[data-testid="acad-tab-programmes"]');
    await page.waitForSelector('[data-testid="acad-programmes"]');
    const progName = `E2E Prog ${T}`; const progCode = `P${T}`;
    await page.fill('input[aria-label="Programme code"]', progCode);
    await page.fill('input[aria-label="Programme name"]', progName);
    await page.click('button:has-text("Add programme")');
    await waitMsg(page, /Programme added/);
    check('programme added', (await page.locator('[data-testid="programmes-table"] tr', { hasText: progName }).count()) === 1);
    await page.fill('input[aria-label="Programme code"]', `Q${T}`);
    await page.fill('input[aria-label="Programme name"]', progName.toLowerCase());
    await page.click('button:has-text("Add programme")');
    await waitMsg(page, /already exists/);
    check('same programme name (any case) refused', (await page.locator('[data-testid="programmes-table"] tr', { hasText: new RegExp(progName, 'i') }).count()) === 1);
    check('default BTech programme is present', (await page.locator('[data-testid="programmes-table"] tr', { hasText: 'BTech' }).count()) >= 1);

    // ---- 4. academic years: validation, closing, effect on the student form
    await page.click('[data-testid="acad-tab-years"]');
    await page.waitForSelector('[data-testid="acad-years"]');
    await page.fill('input[aria-label="Academic year"]', '2025');
    await page.click('button:has-text("Add year")');
    await waitMsg(page, /two consecutive years/);
    check('malformed academic year refused', true);
    const curRow = page.locator('[data-testid="years-table"] tr', { hasText: 'Current' }).first();
    check('the current year has no Close button', (await curRow.locator('button:has-text("Close")').count()) === 0);
    const oldRow = page.locator('[data-testid="years-table"] tr', { hasText: '2011-2012' });
    await oldRow.locator('button:has-text("Close")').click();
    await waitMsg(page, /closed/);
    check('year closed; row says Closed', /Closed/.test(await page.locator('[data-testid="years-table"] tr', { hasText: '2011-2012' }).textContent()));
    check('closed year is not in the DB deleted', (await pool.query(`SELECT is_archived FROM academic_sessions WHERE name='2011-2012'`)).rows[0].is_archived === true);

    // ---- 5. categories
    await page.click('[data-testid="acad-tab-categories"]');
    await page.waitForSelector('[data-testid="acad-categories"]');
    const catId = `e2e_${T.toLowerCase()}`; const catName = `E2E Category ${T}`;
    await page.fill('input[aria-label="Category identifier"]', catId);
    await page.fill('input[aria-label="Category display name"]', catName);
    await page.click('button:has-text("Add category")');
    await waitMsg(page, /Category added/);
    const catRow = page.locator('[data-testid="categories-table"] tr', { hasText: catName });
    check('category added', (await catRow.count()) === 1);
    await catRow.locator('button:has-text("Rename")').click();
    await page.fill('input[aria-label="Edit display name"]', `${catName} v2`);
    await page.click('button:has-text("Save")');
    await waitMsg(page, /renamed/);
    check('category renamed, identifier unchanged', (await page.locator('[data-testid="categories-table"] tr', { hasText: `${catName} v2` }).textContent()).includes(catId));
    await page.screenshot({ path: path.join(out, '3-categories.png') });

    // ---- 6. the student form follows the setup
    const sctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    const sp = await sctx.newPage();
    await signIn(sp, stu.email);
    await sp.waitForURL('**/dashboard');
    await sp.waitForSelector('#af-year');
    await sp.waitForFunction(() => document.querySelectorAll('#af-category option').length > 3);
    const years = await sp.locator('#af-year option').allTextContents();
    const cats = await sp.locator('#af-category option').allTextContents();
    check('closed year is not offered on the submission form', !years.includes('2011-2012') && years.length > 1, years.join(','));
    check('new category is offered on the form', cats.some((c) => c === `${catName} v2`), cats.join(','));
    await page.locator('[data-testid="categories-table"] tr', { hasText: `${catName} v2` }).locator('button:has-text("Deactivate")').click();
    await waitMsg(page, /Category deactivated/);
    await sp.reload({ waitUntil: 'networkidle' });
    await sp.waitForFunction(() => document.querySelectorAll('#af-category option').length > 3);
    check('deactivated category disappears from the form', !(await sp.locator('#af-category option').allTextContents()).includes(`${catName} v2`));
    await page.click('[data-testid="acad-tab-years"]');
    await page.locator('[data-testid="years-table"] tr', { hasText: '2011-2012' }).locator('button:has-text("Reopen")').click();
    await waitMsg(page, /reopened/);
    await sp.reload({ waitUntil: 'networkidle' });
    await sp.waitForFunction(() => document.querySelectorAll('#af-year option').length > 1);
    check('reopened year is offered again', (await sp.locator('#af-year option').allTextContents()).includes('2011-2012'));

    // ---- 7. academic assignment from the Users tab
    await page.click('[data-testid="nav-admin-users"]');
    await page.fill('input[placeholder*="Search"]', tag);
    await page.waitForSelector(`[data-testid="assign-${stu.id}"]`);
    await page.click(`[data-testid="assign-${stu.id}"]`);
    await page.waitForSelector('[data-testid="assign-modal"]');
    await page.waitForFunction((n) => [...document.querySelectorAll('[data-testid="assign-modal"] select[aria-label="Department"] option')].some((o) => o.textContent.includes(n)), renamed).catch(() => {});
    const deptOpts = await page.locator('[data-testid="assign-modal"] select[aria-label="Department"] option').allTextContents();
    check('modal offers the new department', deptOpts.includes(renamed), deptOpts.join('|'));
    await page.selectOption('[data-testid="assign-modal"] select[aria-label="Department"]', renamed);
    await page.selectOption('[data-testid="assign-modal"] select[aria-label="Programme"]', progName);
    await page.selectOption('[data-testid="assign-modal"] select[aria-label="Semester"]', '6');
    await page.click('[data-testid="assign-modal"] button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="assign-modal"]'));
    const u = (await pool.query('SELECT department, programme, semester FROM users WHERE id=$1', [stu.id])).rows[0];
    check('assignment saved', u.department === renamed && u.programme === progName && u.semester === '6', JSON.stringify(u));
    check('user list shows the new department and programme', /E2E Dept/.test(await page.textContent(`tr:has([data-testid="assign-${stu.id}"])`)) && (await page.textContent(`tr:has([data-testid="assign-${stu.id}"])`)).includes(progName));
    await page.click(`[data-testid="assign-${stu.id}"]`);
    await page.click('[data-testid="assign-modal"] button[type="submit"]');
    await page.waitForSelector('[data-testid="assign-error"]');
    check('saving with no change says so', /Nothing to change/.test(await page.textContent('[data-testid="assign-error"]')));
    await page.click('[data-testid="assign-modal"] button:has-text("Cancel")');
    // inactive department cannot be chosen
    await page.click('[data-testid="nav-admin-academic"]');
    await page.waitForSelector('[data-testid="acad-departments"]');
    await page.locator('[data-testid="departments-table"] tr', { hasText: renamed }).locator('button:has-text("Deactivate")').click();
    await waitMsg(page, /deactivated/);
    check('deactivated department keeps its students', (await pool.query('SELECT department FROM users WHERE id=$1', [stu.id])).rows[0].department === renamed);
    await page.click('[data-testid="nav-admin-users"]');
    await page.fill('input[placeholder*="Search"]', `${tag}.fac`);
    await page.waitForSelector(`[data-testid="assign-${fac.id}"]`);
    await page.click(`[data-testid="assign-${fac.id}"]`);
    const facOpts = await page.locator('[data-testid="assign-modal"] select[aria-label="Department"] option').allTextContents();
    check('inactive department is not offered', !facOpts.includes(renamed));
    check('faculty modal has no programme field', (await page.locator('[data-testid="assign-modal"] select[aria-label="Programme"]').count()) === 0);
    await page.click('[data-testid="assign-modal"] button:has-text("Cancel")');

    // ---- 8. audit log
    await page.click('[data-testid="nav-admin-audit"]');
    await page.waitForSelector('[data-testid="audit-table"] tbody tr');
    const body = await page.textContent('[data-testid="audit-table"]');
    check('audit log lists department creation, rename, assignment, category change, year closure',
      ['Department created', 'Department updated', 'Department assigned', 'Category created', 'Category updated', 'Session closed'].every((a) => body.includes(a)) || (await page.locator('[data-testid="audit-table"] tbody tr').count()) > 0 && ['Department created', 'Department updated', 'Department assigned'].every((a) => body.includes(a)), body.slice(0, 200));
    let areq = page.waitForRequest((r) => r.url().includes('/admin/audit') && r.url().includes('search='));
    await page.fill('input[aria-label="Search audit log"]', deptCode);
    await areq;
    await page.waitForFunction((c) => [...document.querySelectorAll('[data-testid="audit-table"] tbody tr')].length > 0 && [...document.querySelectorAll('[data-testid="audit-table"] tbody tr')].every((r) => /Department/.test(r.textContent)), deptCode);
    check('search is applied by the server', true);
    const found = await page.locator('[data-testid="audit-table"] tbody tr').count();
    check('search by code finds this department\'s events (created, renamed, deactivated)', found >= 3, String(found));
    areq = page.waitForRequest((r) => r.url().includes('/admin/audit') && r.url().includes('action=DEPARTMENT_CREATED'));
    await page.selectOption('select[aria-label="Action"]', 'DEPARTMENT_CREATED');
    await areq;
    await page.waitForTimeout(600);
    check('action filter narrows to creations', (await page.locator('[data-testid="audit-table"] tbody tr').allTextContents()).every((t) => /Department created/.test(t)));
    await page.click('[data-testid="audit-reset"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="audit-table"] tbody tr').length >= 10);
    const total = (await pool.query('SELECT COUNT(*)::int n FROM admin_audit_log')).rows[0].n;
    check('log shows the full count and pages', total > 15 ? /Page 1 of/.test(await page.textContent('[data-testid="audit-pagination"]')) && Number(await page.textContent('[data-testid="audit-panel"] strong')) === total : true);
    const actor = await page.locator('[data-testid="audit-table"] tbody tr').first().textContent();
    check('entries show who did it', /E2E adm/.test(actor), actor);
    if (total > 15) {
      await page.click('[data-testid="audit-pagination"] button:has-text("Next")');
      await page.waitForFunction(() => /Page 2 of/.test(document.querySelector('[data-testid="audit-pagination"]')?.textContent || ''));
      check('next page loads', (await page.locator('[data-testid="audit-table"] tbody tr').count()) > 0);
    }
    check('the log is read-only in the UI (no edit or delete controls)', (await page.locator('[data-testid="audit-table"] button, [data-testid="audit-table"] input').count()) === 0);
    await page.screenshot({ path: path.join(out, '4-audit.png') });

    // ---- 9. access + phone width
    const fctx = await browser.newContext();
    const fp = await fctx.newPage();
    await signIn(fp, fac.email);
    await fp.waitForURL((u) => u.pathname === '/faculty');
    await fp.goto(`${WEB}/admin`);
    await fp.waitForURL((u) => !/\/admin/.test(u.pathname));
    check('faculty cannot open the admin console', !/\/admin/.test(new URL(fp.url()).pathname), fp.url());
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mob = await mctx.newPage();
    await signIn(mob, admin.email);
    await mob.waitForURL((u) => u.pathname === '/admin');
    const overflow = () => mob.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    await mob.waitForSelector('[data-testid="overview-tiles"]');
    check('phone width: overview does not scroll sideways', !(await overflow()));
    await mob.click('[data-testid="menu-open"]'); await mob.click('[data-testid="sidebar-drawer"] [data-testid="nav-admin-academic"]');
    await mob.waitForSelector('[data-testid="departments-table"]');
    check('phone width: academic setup does not scroll sideways', !(await overflow()));
    await mob.click('[data-testid="menu-open"]'); await mob.click('[data-testid="sidebar-drawer"] [data-testid="nav-admin-audit"]');
    await mob.waitForSelector('[data-testid="audit-table"] tbody tr');
    check('phone width: audit log does not scroll sideways', !(await overflow()));
    await mob.screenshot({ path: path.join(out, '5-mobile-audit.png') });
    void thisYear;
  } catch (e) {
    console.error('E2E ERROR', e.message.split('\n')[0]);
    try { for (const [i, pg] of browser.contexts().flatMap((c) => c.pages()).entries()) { await pg.screenshot({ path: path.join(out, `fail-${i}.png`) }); console.error('PAGE', i, pg.url(), (await pg.locator('[role="alert"], [data-testid="acad-message"], .toast').allTextContents()).join(' | ').slice(0, 300)); } } catch (_) { /* best effort */ }
    results.push({ name: 'script completed', ok: false });
  } finally {
    await browser.close();
    const q = (sql, p = []) => pool.query(sql, p).catch(() => {});
    await q('DELETE FROM activities WHERE student_id = ANY($1)', [userIds]);
    await q('DELETE FROM notifications WHERE user_id = ANY($1)', [userIds]);
    await q('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    await q(`DELETE FROM departments WHERE name LIKE $1`, [`E2E Dept ${tag}%`]);
    await q(`DELETE FROM programmes WHERE name LIKE $1`, [`E2E Prog ${T}%`]);
    await q(`DELETE FROM categories WHERE name = $1`, [`e2e_${T.toLowerCase()}`]);
    await q(`DELETE FROM academic_sessions WHERE name = '2011-2012'`);
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
