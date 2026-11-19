// Phase 8 browser test: notification bell, unread counter, notifications page, read state, links, privacy.
// Needs PostgreSQL, backend on :5001, frontend (next start) on :3000.   node e2e/phase8.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const PASSWORD = 'E2ePass@12345';
const tag = `e8${Date.now()}`;
const T = tag.toUpperCase().slice(-8);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots8';
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


const API = 'http://localhost:5001';
async function apiLogin(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  return (await r.json()).token;
}
async function submitActivity(token, title) {
  const fd = new FormData();
  Object.entries({ title, category: 'hackathon', description: 'E2E notification test', activity_date: '2026-01-15', academic_session: '2025-2026', semester: '5' }).forEach(([k, v]) => fd.append(k, v));
  fd.append('proof', new Blob([Buffer.concat([Buffer.from('%PDF-1.4\n%'), Buffer.from(String(Math.random())), Buffer.from('\n%%EOF')])], { type: 'application/pdf' }), 'cert.pdf');
  const r = await fetch(`${API}/activities`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const j = await r.json(); if (r.status !== 201) throw new Error(`submit failed ${r.status} ${JSON.stringify(j)}`); return j;
}
const bellCount = async (page) => {
  const el = page.locator('[data-testid="bell-count"]');
  return (await el.count()) ? (await el.textContent()).trim() : '0';
};

(async () => {
  const browser = await chromium.launch();
  const userIds = [];
  try {
    const stu = await dbUser('student', 'stu', 'Computer Science & Engineering');
    const fac = await dbUser('faculty', 'fac', 'Computer Science & Engineering');
    const facOut = await dbUser('faculty', 'out', 'Computer Science & Engineering');
    userIds.push(stu.id, fac.id, facOut.id);
    await pool.query(`INSERT INTO faculty_scopes (faculty_id, department) VALUES ($1, 'Computer Science & Engineering'), ($2, 'Mechanical Engineering')`, [fac.id, facOut.id]);
    const stuToken = await apiLogin(stu.email); const facToken = await apiLogin(fac.email);
    const act = await submitActivity(stuToken, `E2E Hackathon ${T}`);

    // ---- student: bell, popover, view all
    const sctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const sp = await sctx.newPage();
    await signIn(sp, stu.email); await sp.waitForURL('**/dashboard');
    await sp.waitForSelector('[data-testid="bell"]');
    await sp.waitForFunction(() => document.querySelector('[data-testid="bell-count"]')?.textContent === '1');
    check('student bell shows 1 unread after submitting', (await bellCount(sp)) === '1');
    await sp.click('[data-testid="bell"]');
    await sp.waitForSelector('[data-testid="notif-item"]');
    check('popover lists the submission notice', /Activity Submitted/.test(await sp.textContent('[data-testid="notif-popover"]')));
    await sp.click('[data-testid="view-all-notifications"]');
    await sp.waitForURL('**/notifications');
    await sp.waitForSelector('[data-testid="notif-row"]');
    check('page lists 1 notification, unread', (await sp.locator('[data-testid="notif-row"]').count()) === 1 && (await sp.getAttribute('[data-testid="notif-row"]', 'data-unread')) === 'true');
    check('summary says 1 unread', /1 unread/.test(await sp.textContent('[data-testid="notif-summary"]')));

    // ---- faculty: only in-scope faculty is told; clicking opens the record and marks it read
    const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const fp = await fctx.newPage();
    await signIn(fp, fac.email); await fp.waitForURL((u) => u.pathname === '/faculty');
    await fp.waitForFunction(() => document.querySelector('[data-testid="bell-count"]')?.textContent === '1');
    check('in-scope faculty bell shows the new activity', (await bellCount(fp)) === '1');
    const octx = await browser.newContext(); const op = await octx.newPage();
    await signIn(op, facOut.email); await op.waitForURL((u) => u.pathname === '/faculty'); await op.waitForSelector('[data-testid="bell"]');
    await op.waitForTimeout(800);
    check('out-of-scope faculty gets nothing', (await bellCount(op)) === '0');
    await octx.close();
    await fp.click('[data-testid="bell"]');
    await fp.click('[data-testid="notif-item"]');
    await fp.waitForURL(`**/activity/${act.id}`);
    await fp.waitForSelector('h1, h2');
    check('clicking the notice opens the linked activity', fp.url().endsWith(`/activity/${act.id}`));
    await fp.waitForFunction(() => !document.querySelector('[data-testid="bell-count"]'));
    check('opening it cleared the unread badge', (await bellCount(fp)) === '0');
    check('and it is marked read in the database', (await pool.query(`SELECT is_read FROM notifications WHERE user_id=$1 AND title='New Activity to Review'`, [fac.id])).rows[0].is_read === true);

    // ---- decision -> student sees it after reload; mark read; filters
    const dec = await fetch(`${API}/activities/${act.id}/approve`, { method: 'PATCH', headers: { Authorization: `Bearer ${facToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ remarks: 'Well done' }) });
    check('faculty approved through the API', dec.status === 200);
    await sp.reload({ waitUntil: 'networkidle' });
    await sp.waitForFunction(() => document.querySelectorAll('[data-testid="notif-row"]').length === 2);
    check('student now has 2 notifications, newest (approval) first', /Approved/.test(await sp.locator('[data-testid="notif-row"]').first().textContent()));
    check('bell counts 2', (await bellCount(sp)) === '2');
    await sp.click('[data-testid="filter-unread"]');
    await sp.waitForFunction(() => document.querySelectorAll('[data-testid="notif-row"]').length === 2);
    await sp.locator('[data-testid="notif-mark"]').first().click();
    await sp.waitForFunction(() => document.querySelectorAll('[data-testid="notif-row"]').length === 1);
    check('marking one read removes it from the Unread filter', (await sp.locator('[data-testid="notif-row"]').count()) === 1);
    await sp.waitForFunction(() => document.querySelector('[data-testid="bell-count"]')?.textContent === '1' || false).catch(() => {});
    await sp.click('[data-testid="mark-all-read"]');
    await sp.waitForSelector('[data-testid="notif-empty"]');
    check('mark all as read empties the Unread filter', /No unread/.test(await sp.textContent('[data-testid="notif-empty"]')));
    check('Mark all is disabled with nothing unread', await sp.locator('[data-testid="mark-all-read"]').isDisabled());
    await sp.click('[data-testid="filter-all"]');
    await sp.waitForFunction(() => document.querySelectorAll('[data-testid="notif-row"]').length === 2);
    check('All still shows both, now read', (await sp.locator('[data-testid="notif-row"][data-unread="true"]').count()) === 0);
    const openBtn = sp.locator('[data-testid="notif-row"]').first().locator('[data-testid="notif-open"]');
    await openBtn.click(); await sp.waitForURL(`**/activity/${act.id}`);
    check('Open goes to the activity', true);

    // ---- privacy: faculty notices never appear for the student
    await sp.goto(`${WEB}/notifications`, { waitUntil: 'networkidle' });
    await sp.waitForSelector('[data-testid="notif-row"]');
    check('student never sees faculty notices', !/New Activity to Review/.test(await sp.textContent('[data-testid="notif-list"]')));

    // ---- paging
    for (let i = 1; i <= 20; i++) await pool.query(`INSERT INTO notifications (user_id,title,message,created_at) VALUES ($1,$2,'bulk', NOW() - ($3 || ' minutes')::interval)`, [stu.id, `Bulk ${i}`, String(i + 5)]);
    await sp.reload({ waitUntil: 'networkidle' });
    await sp.waitForSelector('[data-testid="notif-pagination"]');
    check('22 notifications page at 15 per page', /Page 1 of 2/.test(await sp.textContent('[data-testid="notif-pagination"]')) && (await sp.locator('[data-testid="notif-row"]').count()) === 15);
    await sp.click('[data-testid="notif-pagination"] button:has-text("Next")');
    await sp.waitForFunction(() => /Page 2 of 2/.test(document.querySelector('[data-testid="notif-pagination"]')?.textContent || ''));
    check('page 2 has the remaining 7', (await sp.locator('[data-testid="notif-row"]').count()) === 7);

    // ---- signed-out visitors go to login
    const gctx = await browser.newContext(); const gp = await gctx.newPage();
    await gp.goto(`${WEB}/notifications`, { waitUntil: 'networkidle' });
    await gp.waitForURL('**/login');
    check('signed-out visitors are sent to login', true);
    await gctx.close();

    // ---- phone width
    const mctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const mp = await mctx.newPage();
    await signIn(mp, stu.email); await mp.waitForURL('**/dashboard');
    await mp.goto(`${WEB}/notifications`, { waitUntil: 'networkidle' });
    await mp.waitForSelector('[data-testid="notif-row"]');
    const overflow = async (pg) => pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check('phone width: notifications page does not scroll sideways', !(await overflow(mp)));
    await mp.click('[data-testid="bell"]');
    await mp.waitForSelector('[data-testid="notif-popover"]');
    const box = await mp.locator('[data-testid="notif-popover"]').boundingBox();
    check('phone width: popover stays inside the screen', box.x >= 0 && box.x + box.width <= 390);
    await mp.waitForTimeout(500);
    await mp.screenshot({ path: path.join(out, '3-mobile.png') });
    await sp.goto(`${WEB}/notifications`, { waitUntil: 'networkidle' });
    await sp.waitForSelector('[data-testid="notif-row"]');
    await sp.screenshot({ path: path.join(out, '1-notifications.png') });
  } catch (e) {
    console.error('E2E ERROR', e.message.split('\n')[0]);
    try { for (const [i, pg] of browser.contexts().flatMap((c) => c.pages()).entries()) { await pg.screenshot({ path: path.join(out, `fail-${i}.png`) }); console.error('PAGE', i, pg.url()); } } catch (_) { /* best effort */ }
    results.push({ name: 'script completed', ok: false });
  } finally {
    await browser.close();
    const q = (sql, p = []) => pool.query(sql, p).catch(() => {});
    await q('DELETE FROM activities WHERE student_id = ANY($1)', [userIds]);
    await q('DELETE FROM notifications WHERE user_id = ANY($1)', [userIds]);
    await q('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
