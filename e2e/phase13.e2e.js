// Phase 13 browser test: role-selection login, server-side portal check, role-specific sidebars, admin sections, drawer, themes, palette.
// Needs PostgreSQL, backend on :5001, frontend on :3000.   node e2e/phase13.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const API = 'http://localhost:5001';
const PASSWORD = 'E2ePass@12345';
const tag = `e13${Date.now()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots13';
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

async function dbUser(role, label, superAdmin = false) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const email = `${tag}.${label}@college.test`;
  const id = (await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active,department,enrollment_no,employee_id,is_super_admin)
     VALUES ($1,$2,$3,$4,'ACTIVE',true,'Computer Science & Engineering',$5,$6,$7) RETURNING id`,
    [`E2E ${label} ${tag}`, email, hash, role, role === 'student' ? `${tag}-${label}`.toUpperCase() : null, role === 'faculty' ? `${tag}-${label}`.toUpperCase() : null, superAdmin])).rows[0].id;
  return { id, email, role };
}
async function login(page, portal, email, password = PASSWORD) {
  await page.goto(`${WEB}/login/${portal}`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('[data-testid="login-submit"]');
}
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const navIds = (page) => page.$$eval('[data-testid="sidebar-nav"] [data-testid^="nav-"]', (els) => els.map((e) => e.getAttribute('data-testid')));
const hasToken = (page) => page.evaluate(() => Object.keys(localStorage).some((k) => /token/i.test(k) && localStorage.getItem(k)));

(async () => {
  const stu = await dbUser('student', 'stu'); const fac = await dbUser('faculty', 'fac');
  const adm = await dbUser('admin', 'adm'); const sup = await dbUser('admin', 'sup', true);
  const ids = [stu.id, fac.id, adm.id, sup.id];
  const browser = await chromium.launch();
  try {
    // ---- login chooser
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
    for (const r of ['student', 'faculty', 'admin']) check(`chooser offers the ${r} portal`, (await p.locator(`[data-testid="portal-${r}"]`).count()) === 1);
    const body = (await p.textContent('body')).toLowerCase();
    for (const bad of ['demo', 'password123', 'big tech', 'major project', 'postgresql', 'express', 'next.js', 'powered by', 'developed by']) check(`login screen has no "${bad}" text`, !body.includes(bad));
    check('chooser is short (no long paragraphs)', body.length < 900, String(body.length));
    check('chooser has no sideways scroll', !(await sideways(p)));
    await p.screenshot({ path: path.join(out, 'chooser-light.png') });
    await p.click('[data-testid="portal-faculty"]'); await p.waitForURL('**/login/faculty');
    check('portal page names the portal', /faculty/i.test(await p.textContent('[data-testid="portal-title"]')));
    await p.click('[data-testid="change-portal"]'); await p.waitForURL((u) => u.pathname === '/login');
    check('"change portal" returns to the chooser', true);
    await p.goto(`${WEB}/login/nonsense`, { waitUntil: 'networkidle' });
    check('unknown portal slug goes back to the chooser', new URL(p.url()).pathname === '/login');

    // ---- portal enforced by the server
    for (const [who, wrong] of [[stu, 'faculty'], [stu, 'admin'], [fac, 'student'], [fac, 'admin'], [adm, 'student'], [adm, 'faculty']]) {
      const c = await browser.newContext(); const q = await c.newPage();
      await login(q, wrong, who.email);
      await q.waitForSelector('[role="alert"]');
      check(`${who.role} through the ${wrong} portal is refused, with no session`, new URL(q.url()).pathname === `/login/${wrong}` && !(await hasToken(q)));
      await c.close();
    }
    const direct = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: stu.email, password: PASSWORD, portal: 'faculty' }) }));
    const dj = await direct.json().catch(() => ({}));
    check('API itself returns 403 PORTAL_MISMATCH and no token (not just the UI)', direct.status === 403 && dj.code === 'PORTAL_MISMATCH' && !dj.token, JSON.stringify(dj));
    const evil = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: stu.email, password: PASSWORD, portal: ['student'] }) });
    check('malformed portal value is rejected', evil.status === 400);

    // ---- each role: right portal, right home, right sidebar
    const expect = {
      student: { portal: 'student', url: '**/dashboard', must: ['nav-activities', 'nav-portfolio', 'nav-notifications', 'nav-profile', 'nav-support'], never: ['nav-verification', 'nav-analytics', 'nav-admin-users'] },
      faculty: { portal: 'faculty', url: '**/faculty', must: ['nav-verification', 'nav-analytics', 'nav-notifications', 'nav-profile', 'nav-support'], never: ['nav-activities', 'nav-portfolio', 'nav-admin-users'] },
    };
    for (const [r, u] of [['student', stu], ['faculty', fac]]) {
      const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const q = await c.newPage();
      await login(q, expect[r].portal, u.email); await q.waitForURL(expect[r].url); await q.waitForSelector('[data-testid="sidebar-nav"]');
      const ids2 = await navIds(q);
      check(`${r}: lands on own home with the matching sidebar`, expect[r].must.every((i) => ids2.includes(i)), ids2.join(','));
      check(`${r}: sidebar hides other roles' items`, expect[r].never.every((i) => !ids2.includes(i)), ids2.join(','));
      check(`${r}: top bar shows account menu and bell`, (await q.locator('[data-testid="nav-avatar-menu-button"]').count()) === 1 && (await q.locator('[data-testid="bell"]').count()) === 1);
      check(`${r}: exactly one item is marked current`, (await q.locator('[data-testid="sidebar-nav"] [aria-current="page"]').count()) === 1);
      await q.screenshot({ path: path.join(out, `${r}-light.png`) });
      // a role cannot open another role's pages
      const other = r === 'student' ? '/faculty' : '/admin';
      await q.goto(`${WEB}${other}`); await q.waitForURL((x) => !x.pathname.startsWith(other)).catch(() => {});
      check(`${r}: opening ${other} directly is turned away`, !new URL(q.url()).pathname.startsWith(other), q.url());
      await c.close();
    }
    for (const [label, u, isSuper] of [['admin', adm, false], ['super admin', sup, true]]) {
      const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const q = await c.newPage();
      await login(q, 'admin', u.email); await q.waitForURL((u) => u.pathname === '/admin'); await q.waitForSelector('[data-testid="overview-tiles"]');
      const ids2 = await navIds(q);
      const sections = ['overview', 'users', 'import', 'faculty', 'academic', 'support', 'audit'];
      check(`${label}: sidebar lists every admin section`, sections.every((s) => ids2.includes(`nav-admin-${s}`)), ids2.join(','));
      check(`${label}: Administrators section ${isSuper ? 'is' : 'is not'} shown`, ids2.includes('nav-admin-administrators') === isSuper);
      check(`${label}: admin sidebar has no student/faculty items`, !ids2.includes('nav-activities') && !ids2.includes('nav-portfolio'));
      if (!isSuper) {
        for (const s of ['users', 'faculty', 'audit']) {
          await q.click(`[data-testid="nav-admin-${s}"]`); await q.waitForURL(`**/admin?tab=${s}`);
          check(`${label}: sidebar "${s}" opens that section and marks it current`, !!(await q.waitForSelector(`[data-testid="nav-admin-${s}"][aria-current="page"]`, { timeout: 5000 }).catch(() => null)));
        }
        await q.reload({ waitUntil: 'networkidle' });
        check(`${label}: section survives a reload`, new URL(q.url()).searchParams.get('tab') === 'audit' && (await q.getAttribute('[data-testid="nav-admin-audit"]', 'aria-current')) === 'page');
        await q.goto(`${WEB}/admin?tab=bogus`, { waitUntil: 'networkidle' });
        check(`${label}: unknown section falls back to Overview`, !!(await q.waitForSelector('[data-testid="nav-admin-overview"][aria-current="page"]', { timeout: 5000 }).catch(() => null)));
        await q.screenshot({ path: path.join(out, 'admin-light.png') });
        // sign out from the sidebar
        await q.click('[data-testid="sidebar-signout"]'); await q.waitForURL('**/login');
        check(`${label}: sidebar sign out clears the session`, !(await hasToken(q)));
        await q.goto(`${WEB}/admin`); await q.waitForURL('**/login');
        check(`${label}: after sign-out protected pages go to login`, true);
      }
      await c.close();
    }

    // ---- phone: drawer, no sideways scroll, per role
    const mc = await browser.newContext({ viewport: { width: 390, height: 800 } }); const m = await mc.newPage();
    await m.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
    check('phone: chooser fits without sideways scroll', !(await sideways(m)));
    await login(m, 'student', stu.email); await m.waitForURL('**/dashboard');
    check('phone: sidebar is hidden until opened', (await m.locator('[data-testid="sidebar-drawer"]').count()) === 0);
    await m.click('[data-testid="menu-open"]'); await m.waitForSelector('[data-testid="sidebar-drawer"]');
    await m.click('[data-testid="sidebar-drawer"] [data-testid="nav-portfolio"]'); await m.waitForURL('**/portfolio');
    check('phone: choosing an item navigates and closes the drawer', await m.waitForSelector('[data-testid="sidebar-drawer"]', { state: 'detached', timeout: 5000 }).then(() => true).catch(() => false));
    check('phone: portfolio page has no sideways scroll', !(await sideways(m)));
    await m.screenshot({ path: path.join(out, 'student-phone.png') });
    await mc.close();

    // ---- dark mode on the new shell + palette
    const dc = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }); const d = await dc.newPage();
    await d.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
    check('dark OS: chooser page is dark', (await d.getAttribute('html', 'data-theme')) === 'dark');
    await d.screenshot({ path: path.join(out, 'chooser-dark.png') });
    await login(d, 'faculty', fac.email); await d.waitForURL((u) => u.pathname === '/faculty'); await d.waitForSelector('[data-testid="sidebar"]');
    await d.screenshot({ path: path.join(out, 'faculty-dark.png') });
    check('dark: sidebar uses the dark surface (not light)', (await d.$eval('[data-testid="sidebar"]', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(25, 35, 34)');
    await dc.close();
    const lc = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' }); const l = await lc.newPage();
    await l.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
    check('light: page background is the new palette (#F4F6F5)', (await l.$eval('body', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(244, 246, 245)');
    await lc.close();
  } finally {
    await browser.close();
    const q = (sql, p = []) => pool.query(sql, p).catch(() => {});
    await q('DELETE FROM notifications WHERE user_id = ANY($1)', [ids]);
    await q('DELETE FROM users WHERE id = ANY($1)', [ids]);
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
