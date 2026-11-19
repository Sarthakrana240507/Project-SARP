// Phase 4 browser test. Needs: PostgreSQL, backend on :5001, frontend (next start) on :3000, seeded demo data.
//   node e2e/phase4.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const PASSWORD = 'E2ePass@12345';
const tag = `e2e${Date.now()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots';
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

async function dbUser({ role, email, department, superAdmin = false }) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  return (await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active,department,is_super_admin,enrollment_no)
     VALUES ($1,$2,$3,$4,'ACTIVE',true,$5,$6,$7) RETURNING id`,
    [`E2E ${role} ${tag}`, email, hash, role, department, superAdmin, role === 'student' ? email.split('@')[0].toUpperCase() : null])).rows[0].id;
}
async function signIn(page, email, password) {
  // sign in through the portal that matches the account (the server also checks the role)
  const { rows: [who] } = await pool.query('SELECT role FROM users WHERE email = $1', [email]);
  await page.goto(`${WEB}/login/${who.role}`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
}

(async () => {
  const browser = await chromium.launch();
  try {
    // ---- fixtures
    const superEmail = `${tag}.super@college.test`;
    const adminEmail = `${tag}.admin@college.test`;
    await dbUser({ role: 'admin', email: superEmail, department: null, superAdmin: true });
    await dbUser({ role: 'admin', email: adminEmail, department: null });
    const cseStu = await dbUser({ role: 'student', email: `${tag}.cse@college.test`, department: 'Computer Science & Engineering' });
    const eceStu = await dbUser({ role: 'student', email: `${tag}.ece@college.test`, department: 'Electronics & Communication' });
    await pool.query(`INSERT INTO activities (student_id,title,category,status) VALUES ($1,$2,'hackathon','pending'),($3,$4,'hackathon','pending')`,
      [cseStu, `CSE work ${tag}`, eceStu, `ECE work ${tag}`]);

    // ---- 1. Super Admin provisions a faculty member through the UI
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const admin = await ctx.newPage();
    await signIn(admin, superEmail, PASSWORD);
    await admin.waitForURL((u) => u.pathname === '/admin');
    await admin.click('[data-testid="nav-admin-faculty"]');
    await admin.click('[data-testid="add-faculty"]');
    const facEmail = `${tag}.fac@college.test`;
    await admin.fill('#ff-id', `${tag}-F1`);
    await admin.fill('#ff-name', `Prof ${tag}`);
    await admin.fill('#ff-email', facEmail);
    await admin.selectOption('#ff-dept', { label: 'Electronics & Communication' });
    await admin.fill('#ff-desig', 'Associate Professor');
    await admin.click('button:has-text("Add faculty"):not([data-testid])');
    await admin.waitForSelector('[role="status"]');
    const notice = await admin.textContent('[role="status"]');
    check('faculty created; UI says no email was sent', /Invited/.test(notice) && /not configured|no email/i.test(notice), notice);
    await admin.fill('input[aria-label="Search faculty"]', tag);
    await admin.waitForSelector(`text=${facEmail}`);
    const rowText = await admin.textContent('[data-testid="faculty-table"] tbody tr');
    check('row shows Invited and default scope = own department', /Invited/.test(rowText) && /Electronics & Communication/.test(rowText), rowText);
    await admin.screenshot({ path: path.join(out, '1-faculty-list.png') });

    // ---- 2. Activation link (hand-off), shown once
    await admin.click('button:has-text("Activation link")');
    const link = await admin.inputValue('[data-testid="one-time-link"]');
    check('hand-off link uses URL fragment (not query string)', link.includes('#token=') && !link.includes('?token='));
    await admin.click('button:has-text("Done")');

    // ---- 3. Faculty activates and signs in
    const fctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const fac = await fctx.newPage();
    await fac.goto(link);
    await fac.fill('#pw', PASSWORD); await fac.fill('#pw2', PASSWORD);
    await fac.click('button[type="submit"]');
    await fac.waitForURL(/login/, { timeout: 15000 }).catch(() => {});
    await signIn(fac, facEmail, PASSWORD);
    await fac.waitForURL((u) => u.pathname === '/faculty');
    await fac.waitForSelector('[data-testid="scope-banner"]');
    check('faculty banner shows own scope', /Electronics & Communication/.test(await fac.textContent('[data-testid="scope-banner"]')));
    await fac.fill('input[aria-label="Search records"]', tag); // the queue is paged, so narrow it to this test's records
    await fac.waitForSelector(`text=ECE work ${tag}`);
    check('queue shows ECE student activity', true);
    check('queue hides CSE student activity', (await fac.locator(`text=CSE work ${tag}`).count()) === 0);
    await fac.screenshot({ path: path.join(out, '2-faculty-scoped.png') });

    // ---- 4. Admin widens scope to all departments; reviewer sees both after reload
    await admin.click(`[data-testid^="faculty-row-"] >> text=Scope`);
    await admin.check('[data-testid="scope-all"]');
    await admin.click('[data-testid="save-scope"]');
    await admin.waitForSelector('text=Verification scope updated');
    await fac.reload();
    await fac.fill('input[aria-label="Search records"]', tag);
    await fac.waitForSelector(`text=CSE work ${tag}`);
    check('after "All departments" the reviewer sees both students', (await fac.locator(`text=ECE work ${tag}`).count()) > 0);
    check('banner updates to all departments', /all departments/i.test(await fac.textContent('[data-testid="scope-banner"]')));

    // ---- 5. Empty scope: nothing visible, with an honest explanation
    await admin.click(`[data-testid^="faculty-row-"] >> text=Scope`);
    await admin.uncheck('[data-testid="scope-all"]');
    check('empty scope warns the admin', (await admin.locator('text=cannot verify any student').count()) === 1);
    await admin.click('[data-testid="save-scope"]');
    await admin.waitForSelector('text=Verification scope updated');
    await fac.reload();
    await fac.waitForSelector('[data-testid="scope-banner"]');
    check('empty scope: banner explains and queue is empty',
      /no verification scope/i.test(await fac.textContent('[data-testid="scope-banner"]')) && (await fac.locator(`text=CSE work ${tag}`).count()) === 0);

    // ---- 6. Faculty CSV import through the UI
    await admin.click('button:has-text("Import from CSV")');
    const csv = path.join(out, 'faculty.csv');
    fs.writeFileSync(csv, `faculty_id,name,email,department,designation\n${tag}-I1,Imported One,${tag}.i1@college.test,CSE,Lecturer\n${tag}-I2,Imported Two,bad-email,CSE,\n`);
    await admin.setInputFiles('[data-testid="csv-input"]', csv);
    await admin.click('button:has-text("Preview import")');
    await admin.waitForSelector('[data-testid="import-preview"]');
    const prev = await admin.textContent('[data-testid="import-preview"]');
    check('faculty CSV preview shows 1 valid and 1 error row', /Valid\s*1/.test(prev) && /Errors\s*1/.test(prev) && /Faculty ID/.test(prev), prev.slice(0, 200));
    await admin.click('button:has-text("Import 1 valid row")');
    await admin.waitForSelector('[data-testid="import-result"]');
    check('faculty CSV confirmed', /1 accounts created/.test(await admin.textContent('[data-testid="import-result"]')));
    const imp = (await pool.query(`SELECT role,status FROM users WHERE email = $1`, [`${tag}.i1@college.test`])).rows[0];
    check('imported faculty exists as INVITED faculty', imp && imp.role === 'faculty' && imp.status === 'INVITED');

    // ---- 7. Super Admin vs regular admin
    check('Super Admin sees the Administrators tab', (await admin.locator('[data-testid="nav-admin-administrators"]').count()) === 1);
    await admin.click('[data-testid="nav-admin-administrators"]');
    await admin.fill('#ad-name', `Second Admin ${tag}`);
    await admin.fill('#ad-email', `${tag}.second@college.test`);
    await admin.click('button:has-text("Add administrator")');
    await admin.waitForSelector('text=was added as Invited');
    check('Super Admin created an administrator', (await admin.locator(`text=${tag}.second@college.test`).count()) >= 1);

    const rctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const reg = await rctx.newPage();
    await signIn(reg, adminEmail, PASSWORD);
    await reg.waitForURL((u) => u.pathname === '/admin');
    check('regular admin does not see the Administrators tab', (await reg.locator('[data-testid="nav-admin-administrators"]').count()) === 0);
    await reg.click('[data-testid="nav-admin-users"]');
    await reg.waitForSelector('tbody select');
    const adminOpt = reg.locator('tbody select').first().locator('option[value="admin"]');
    check('regular admin cannot pick the Admin role', await adminOpt.isDisabled());
    // the server refuses even if the UI is bypassed
    const apiToken = await reg.evaluate(() => localStorage.getItem('token'));
    const direct = await reg.evaluate(async (t) => (await fetch('http://localhost:5001/admin/administrators', { headers: { Authorization: `Bearer ${t}` } })).status, apiToken);
    check('server returns 403 for administrators API to regular admin', direct === 403, String(direct));

    // ---- 8. Phone layout: no horizontal scroll on the faculty manager
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mob = await mctx.newPage();
    await signIn(mob, superEmail, PASSWORD);
    await mob.waitForURL((u) => u.pathname === '/admin');
    await mob.click('[data-testid="menu-open"]'); await mob.click('[data-testid="sidebar-drawer"] [data-testid="nav-admin-faculty"]');
    await mob.waitForSelector('[data-testid="add-faculty"]');
    const overflow = await mob.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check('phone width: page has no horizontal scroll', !overflow);
    await mob.screenshot({ path: path.join(out, '3-mobile-faculty.png') });
    await admin.screenshot({ path: path.join(out, '4-administrators.png') });
  } catch (e) {
    console.error('E2E ERROR', e);
    results.push({ name: 'script completed', ok: false });
  } finally {
    await browser.close();
    // cleanup
    const ids = (await pool.query(`SELECT id FROM users WHERE email LIKE $1`, [`${tag}%`])).rows.map((r) => r.id);
    await pool.query('DELETE FROM activities WHERE student_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM import_batches WHERE uploaded_by = ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
