// Phase 11 browser test: Contact & Support page, ticket form, history, admin ticket management, privacy of internal notes.
// Needs PostgreSQL, backend on :5001, frontend (next start) on :3000 built with NEXT_PUBLIC_SUPPORT_EMAIL set.   node e2e/phase11.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const PASSWORD = 'E2ePass@12345';
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@example.test';
const tag = `e11${Date.now()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots11';
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

async function dbUser(role, label) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const email = `${tag}.${label}@college.test`;
  const id = (await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active,department,enrollment_no,employee_id)
     VALUES ($1,$2,$3,$4,'ACTIVE',true,'Computer Science & Engineering',$5,$6) RETURNING id`,
    [`E2E ${label} ${tag}`, email, hash, role, role === 'student' ? `${tag}-${label}`.toUpperCase() : null, role === 'faculty' ? `${tag}-${label}`.toUpperCase() : null])).rows[0].id;
  return { id, email, name: `E2E ${label} ${tag}` };
}
async function signIn(page, email) {
  // sign in through the portal that matches the account (the server also checks the role)
  const { rows: [who] } = await pool.query('SELECT role FROM users WHERE email = $1', [email]);
  await page.goto(`${WEB}/login/${who.role}`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

(async () => {
  const stu = await dbUser('student', 'stu'); const fac = await dbUser('faculty', 'fac'); const adm = await dbUser('admin', 'adm');
  const userIds = [stu.id, fac.id, adm.id];
  const browser = await chromium.launch();
  try {
    // ---- signed out
    const anon = await (await browser.newContext()).newPage();
    await anon.goto(`${WEB}/support`, { waitUntil: 'networkidle' });
    await anon.waitForURL(/\/login/);
    check('signed-out visitors are sent to sign in', true);
    check('login page offers the configured support address as a mailto link',
      (await anon.getAttribute('[data-testid="login-support-email"]', 'href')) === `mailto:${SUPPORT_EMAIL}`);

    // ---- student: page, contact block, prefilled form
    const sctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const s = await sctx.newPage();
    await signIn(s, stu.email);
    await s.click('[data-testid="nav-support"]');
    await s.waitForURL(/\/support/);
    await s.waitForSelector('[data-testid="ticket-form"]');
    check('Support is in the navigation', true);
    check('page shows the SARP Support heading and a short description', (await s.textContent('[data-testid="support-contact"]')).includes('SARP Support'));
    check('support email is a clickable mailto link using the configured address',
      (await s.getAttribute('[data-testid="support-email"]', 'href')) === `mailto:${SUPPORT_EMAIL}` && (await s.textContent('[data-testid="support-email"]')) === SUPPORT_EMAIL);
    check('name and registered email are pre-filled; the email cannot be edited',
      (await s.inputValue('#t-name')) === stu.name && (await s.inputValue('#t-email')) === stu.email && (await s.getAttribute('#t-email', 'readonly')) !== null);
    const catLabels = await s.$$eval('#t-category option', (o) => o.map((x) => x.textContent));
    check('all seven categories are offered', ['Login Problems', 'Account Issues', 'Activity Submission', 'Document Upload', 'Verification Problems', 'Technical Issues', 'Other'].every((c) => catLabels.includes(c)), catLabels.join('|'));

    // ---- validation
    await s.click('[data-testid="ticket-submit"]');
    await s.waitForSelector('[role="alert"]');
    const alerts = await s.$$eval('[data-testid="ticket-form"] [role="alert"]', (a) => a.length);
    check('an empty form shows an error for each missing field and stores nothing',
      alerts >= 3 && (await pool.query('SELECT COUNT(*)::int n FROM support_tickets WHERE user_id=$1', [stu.id])).rows[0].n === 0, String(alerts));

    // ---- submit
    await s.selectOption('#t-category', 'DOCUMENT_UPLOAD');
    await s.fill('#t-subject', 'Certificate will not upload');
    await s.fill('#t-message', 'I choose a PDF of 2 MB and the upload spinner never finishes.');
    await s.click('[data-testid="ticket-submit"]');
    await s.waitForSelector('[data-testid="ticket-confirmation"]');
    const ref = (await s.textContent('[data-testid="ticket-ref"]')).trim();
    check('confirmation shows a unique ticket ID', /^SUP-\d{6}$/.test(ref), ref);
    const row = (await pool.query('SELECT * FROM support_tickets WHERE ticket_ref=$1', [ref])).rows[0];
    check('ticket is stored in PostgreSQL, linked to the signed-in student, status OPEN',
      row && row.user_id === stu.id && row.status === 'OPEN' && row.category === 'DOCUMENT_UPLOAD' && row.email === stu.email);
    check('form is cleared after sending', (await s.inputValue('#t-subject')) === '' && (await s.inputValue('#t-message')) === '');
    check('page does not claim that an email was sent', !/email (was )?sent|we have emailed/i.test(await s.textContent('main')));
    await s.waitForSelector(`[data-testid="ticket-${ref}"]`);
    check('ticket appears in the history with status Open', (await s.textContent(`[data-testid="ticket-${ref}"]`)).includes('Open'));
    check('the new ticket opens in full', (await s.textContent(`[data-testid="ticket-${ref}"]`)).includes('upload spinner never finishes'));
    await s.screenshot({ path: path.join(out, '1-student-support.png'), fullPage: true });

    // ---- admin: sees the ticket, notified, manages it
    const actx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const a = await actx.newPage();
    await signIn(a, adm.email);
    const adminNote = (await pool.query(`SELECT link, message FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [adm.id])).rows[0];
    check('admins get an in-app notification for a new ticket', adminNote && adminNote.message.includes(ref) && adminNote.link === '/admin?tab=support', JSON.stringify(adminNote));
    await a.goto(`${WEB}${adminNote.link}`, { waitUntil: 'networkidle' });
    await a.waitForSelector('[data-testid="support-manager"]');
    check('the notification link opens the Support Tickets tab', true);
    await a.fill('[data-testid="ticket-search"]', ref.toLowerCase());
    await a.waitForSelector(`[data-testid="admin-ticket-${ref}"]`);
    await a.waitForFunction(() => document.querySelectorAll('[data-testid^="admin-ticket-"]').length === 1);
    check('searching a ticket ID finds exactly that ticket (case-insensitive)', true);
    await a.fill('[data-testid="ticket-search"]', '');
    await a.selectOption('[data-testid="ticket-category-filter"]', 'LOGIN');
    await a.waitForFunction((r) => !document.querySelector(`[data-testid="admin-ticket-${r}"]`), ref);
    check('category filter hides tickets of other categories', true);
    await a.selectOption('[data-testid="ticket-category-filter"]', 'DOCUMENT_UPLOAD');
    await a.selectOption('[data-testid="ticket-status-filter"]', 'RESOLVED');
    await a.waitForFunction((r) => !document.querySelector(`[data-testid="admin-ticket-${r}"]`), ref);
    check('status filter hides tickets in other statuses', true);
    await a.selectOption('[data-testid="ticket-status-filter"]', 'all');
    await a.click(`[data-testid="admin-ticket-${ref}"] button`);
    await a.waitForSelector('[data-testid="ticket-detail"]');
    check('opening a ticket shows the full message', (await a.textContent('[data-testid="ticket-message"]')).includes('upload spinner never finishes'));
    const SECRET = `INTERNAL-${tag}-checked the storage quota`;
    await a.selectOption('[data-testid="detail-status"]', 'IN_PROGRESS');
    await a.fill('[data-testid="detail-notes"]', SECRET);
    await a.click('[data-testid="detail-save"]');
    await a.waitForSelector('[data-testid="detail-saved"]');
    const after = (await pool.query('SELECT status, admin_notes, updated_by FROM support_tickets WHERE ticket_ref=$1', [ref])).rows[0];
    check('status and internal notes are saved by the admin', after.status === 'IN_PROGRESS' && after.admin_notes === SECRET && after.updated_by === adm.id);
    check('the status count chips update', (await a.textContent('[data-testid="count-IN_PROGRESS"]')).includes('In Progress: '));
    await a.screenshot({ path: path.join(out, '2-admin-support.png'), fullPage: true });

    // ---- student sees the new status but never the internal notes
    await s.goto(`${WEB}/support`, { waitUntil: 'networkidle' });
    await s.waitForSelector(`[data-testid="ticket-${ref}"]`);
    check('student sees the updated status', (await s.textContent(`[data-testid="ticket-${ref}"]`)).includes('In Progress'));
    check('internal notes appear nowhere on the student page', !(await s.content()).includes(SECRET));
    const apiLeak = await s.evaluate(async () => { const t = localStorage.getItem('token'); const r = await fetch('http://localhost:5001/support/tickets', { headers: { Authorization: `Bearer ${t}` } }); return r.text(); });
    check('internal notes are not in the API response the student receives either', !apiLeak.includes(SECRET) && !apiLeak.includes('admin_notes'));
    await s.goto(`${WEB}/notifications`, { waitUntil: 'networkidle' });
    check('student is notified of the status change, with no note text',
      (await s.textContent('main')).includes(`Your ticket ${ref} is now in progress.`) && !(await s.textContent('main')).includes('storage quota'));

    // ---- other users cannot read or manage it
    const other = await s.evaluate(async (r) => { const t = localStorage.getItem('token'); const x = await fetch(`http://localhost:5001/admin/support/tickets/${r}`, { headers: { Authorization: `Bearer ${t}` } }); return x.status; }, ref);
    check('a student cannot call the admin ticket API', other === 403, String(other));

    // ---- faculty can file a ticket too, and has no admin access
    const f = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await signIn(f, fac.email);
    await f.goto(`${WEB}/support`, { waitUntil: 'networkidle' });
    await f.selectOption('#t-category', 'VERIFICATION');
    await f.fill('#t-subject', 'Student missing from my queue');
    await f.fill('#t-message', 'One of my department students never shows up in the verification queue.');
    await f.click('[data-testid="ticket-submit"]');
    await f.waitForSelector('[data-testid="ticket-confirmation"]');
    check('faculty can submit a ticket', true);
    check('faculty see only their own ticket', (await f.$$eval('[data-testid^="ticket-SUP"]', (e) => e.length)) === 1);

    // ---- rate limit: five tickets per hour
    const token = await s.evaluate(() => localStorage.getItem('token'));
    for (let i = 0; i < 4; i++) {
      await fetch('http://localhost:5001/support/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: stu.name, email: stu.email, category: 'OTHER', subject: `Filler ticket ${i}`, message: 'Filling the hourly allowance for the test.' }) });
    }
    await s.goto(`${WEB}/support`, { waitUntil: 'networkidle' });
    await s.selectOption('#t-category', 'OTHER'); await s.fill('#t-subject', 'The sixth ticket'); await s.fill('#t-message', 'This one should be refused for now.');
    await s.click('[data-testid="ticket-submit"]');
    await s.waitForSelector('[data-testid="ticket-error"]');
    check('a sixth ticket within the hour is refused with a clear message', /wait a while/i.test(await s.textContent('[data-testid="ticket-error"]')));
    check('refused ticket was not stored', (await pool.query(`SELECT COUNT(*)::int n FROM support_tickets WHERE user_id=$1 AND subject='The sixth ticket'`, [stu.id])).rows[0].n === 0);
    check('five tickets fit on one history page', (await s.$$eval('[data-testid^="ticket-SUP"]', (e) => e.length)) === 5 && !(await s.$('[data-testid="ticket-pagination"]')));
    await pool.query(`INSERT INTO support_tickets (user_id,name,email,category,subject,message) SELECT $1,$2,$3,'OTHER','Older ticket '||g,'Added directly to test paging.' FROM generate_series(1,3) g`, [stu.id, stu.name, stu.email]);
    await s.reload({ waitUntil: 'networkidle' });
    await s.waitForSelector('[data-testid="ticket-pagination"]');
    check('more than five tickets page the history', /Page 1 of 2/.test(await s.textContent('[data-testid="ticket-pagination"]')));
    await s.click('[data-testid="ticket-pagination"] button:has-text("Next")');
    await s.waitForFunction(() => /Page 2 of 2/.test(document.querySelector('[data-testid="ticket-pagination"]')?.textContent || ''));
    await s.waitForFunction(() => document.querySelectorAll('[data-testid^="ticket-SUP"]').length === 3);
    check('page 2 shows the remaining three', true);

    // ---- themes and phone
    await s.evaluate(() => { localStorage.setItem('sarp-theme', 'dark'); });
    await s.reload({ waitUntil: 'networkidle' });
    check('support page honours the dark theme', (await s.getAttribute('html', 'data-theme')) === 'dark');
    await s.screenshot({ path: path.join(out, '3-student-support-dark.png'), fullPage: true });
    await a.evaluate(() => { localStorage.setItem('sarp-theme', 'dark'); });
    await a.reload({ waitUntil: 'networkidle' });
    await a.waitForSelector('[data-testid="support-manager"]');
    await a.screenshot({ path: path.join(out, '4-admin-support-dark.png'), fullPage: true });
    const mctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const m = await mctx.newPage();
    await signIn(m, stu.email);
    await m.goto(`${WEB}/support`, { waitUntil: 'networkidle' });
    check('phone: support page does not scroll sideways', !(await sideways(m)));
    await m.screenshot({ path: path.join(out, '5-mobile-support.png'), fullPage: true });
    await a.setViewportSize({ width: 375, height: 800 });
    await a.reload({ waitUntil: 'networkidle' });
    await a.waitForSelector('[data-testid="support-manager"]');
    check('phone: admin ticket list does not scroll sideways', !(await sideways(a)));
  } catch (e) {
    console.error('E2E ERROR', e.message.split('\n')[0]);
    try { for (const [i, pg] of browser.contexts().flatMap((c) => c.pages()).entries()) { await pg.screenshot({ path: path.join(out, `fail-${i}.png`) }); console.error('PAGE', i, pg.url()); } } catch (_) { /* best effort */ }
    results.push({ name: 'script completed', ok: false });
  } finally {
    await browser.close();
    const q = (sql, p = []) => pool.query(sql, p).catch(() => {});
    await q('DELETE FROM support_tickets WHERE user_id = ANY($1)', [userIds]);
    await q('DELETE FROM notifications WHERE user_id = ANY($1)', [userIds]);
    await q('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
