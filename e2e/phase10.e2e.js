// Phase 10 browser test: light/dark/system themes, no flash, persistence, account sync, charts, and an automated WCAG contrast audit of every page in both themes.
// Needs PostgreSQL, backend on :5001, frontend (next start) on :3000.   node e2e/phase10.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const PASSWORD = 'E2ePass@12345';
const tag = `e10${Date.now()}`;
const T = tag.toUpperCase().slice(-8);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots10';
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
const DARK_CANVAS = 'rgb(17, 24, 23)';
const LIGHT_CANVAS = 'rgb(244, 246, 245)';
async function apiLogin(email) {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  return (await r.json()).token;
}
async function submitActivity(token, title) {
  const fd = new FormData();
  Object.entries({ title, category: 'hackathon', description: 'Theme audit activity with a reasonably long description so wrapping is exercised.', activity_date: '2026-01-15', academic_session: '2025-2026', semester: '5' }).forEach(([k, v]) => fd.append(k, v));
  fd.append('proof', new Blob([Buffer.concat([Buffer.from('%PDF-1.4\n%'), Buffer.from(String(Math.random())), Buffer.from('\n%%EOF')])], { type: 'application/pdf' }), 'cert.pdf');
  const r = await fetch(`${API}/activities`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const j = await r.json(); if (r.status !== 201) throw new Error(`submit failed ${r.status} ${JSON.stringify(j)}`); return j;
}
const decide = (token, id, act, remarks) => fetch(`${API}/activities/${id}/${act}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ remarks }) });

const theme = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const pref = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme-pref'));
const stored = (page) => page.evaluate(() => localStorage.getItem('sarp-theme'));
const bodyBg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const dbTheme = async (id) => (await pool.query('SELECT theme_preference t FROM users WHERE id=$1', [id])).rows[0].t;
const waitDb = async (id, want) => { for (let i = 0; i < 30; i++) { if ((await dbTheme(id)) === want) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

// ---- WCAG contrast audit, evaluated inside the page --------------------------------------------
const AUDIT = () => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].replace('/', ' ').split(/[\s,]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
  // Candidate backgrounds behind an element (a gradient contributes each of its colour stops).
  const backgrounds = (el) => {
    const layers = [];
    let e = el;
    while (e) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        const stops = (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(parse).filter((c) => c && c[3] > 0); // fully transparent stops (Tailwind adds them) show what is behind, not a colour
        if (stops.length) { layers.push({ stops }); break; }
      }
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) { layers.push({ stops: [c] }); if (c[3] >= 1) break; }
      e = e.parentElement;
    }
    let cands = [[255, 255, 255, 1]];
    const root = parse(getComputedStyle(document.documentElement).backgroundColor); if (root && root[3] > 0) cands = [root];
    for (const L of layers.reverse()) cands = L.stops.flatMap((s) => cands.map((u) => over(s, u)));
    return cands;
  };
  const fails = []; let checked = 0; let skipped = 0;
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const text = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = n.parentElement; if (!el || seen.has(el)) continue;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible' || cs.display === 'none' || !el.getClientRects().length) continue;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    let faded = false; for (let e = el; e; e = e.parentElement) { if (parseFloat(getComputedStyle(e).opacity) < 1) { faded = true; break; } }
    if (faded || el.closest('[disabled],[aria-disabled="true"]') || el.closest('[aria-hidden="true"]')) { skipped++; continue; }
    seen.add(el);
    const svgText = el instanceof SVGElement;
    const fgRaw = parse(svgText ? cs.fill : cs.color); if (!fgRaw) { skipped++; continue; }
    const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    const bgs = backgrounds(svgText ? (el.closest('svg')?.parentElement || document.body) : el);
    let worst = Infinity;
    for (const bg of bgs) { const fg = fgRaw[3] < 1 ? over(fgRaw, bg) : fgRaw; worst = Math.min(worst, ratio(fg, bg)); }
    checked++;
    if (worst < need) fails.push({ text: text.slice(0, 40), el: `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(' ').slice(0, 4).join('.')}`, ratio: Math.round(worst * 100) / 100, need, fg: svgText ? cs.fill : cs.color });
  }
  return { checked, skipped, fails };
};

(async () => {
  const browser = await chromium.launch();
  const userIds = [];
  const shots = (name) => path.join(out, name);
  const auditResults = [];
  try {
    const stu = await dbUser('student', 'stu', 'Computer Science & Engineering');
    const fac = await dbUser('faculty', 'fac', 'Computer Science & Engineering');
    const adm = await dbUser('admin', 'adm', null);
    const stu2 = await dbUser('student', 'two', 'Computer Science & Engineering');
    userIds.push(stu.id, fac.id, adm.id, stu2.id);
    await pool.query(`INSERT INTO support_tickets (user_id,name,email,category,subject,message) SELECT id,name,email,'TECHNICAL','Audit ticket','A ticket so the audit sees a real row and an opened detail form.' FROM users WHERE id = $1`, [stu.id]);
    await pool.query(`INSERT INTO faculty_scopes (faculty_id, department) VALUES ($1, 'Computer Science & Engineering')`, [fac.id]);
    const stuToken = await apiLogin(stu.email); const facToken = await apiLogin(fac.email);
    const acts = {};
    for (const k of ['approved', 'rejected', 'correction', 'pending']) acts[k] = await submitActivity(stuToken, `Theme ${k} ${T}`);
    await decide(facToken, acts.approved.id, 'approve', '');
    await decide(facToken, acts.rejected.id, 'reject', 'The certificate does not show your name.');
    await decide(facToken, acts.correction.id, 'request-correction', 'Please upload a clearer scan.');
    await submitActivity(stuToken, `Theme duplicate ${T}`).catch(() => {});

    // ================= behaviour =================
    // --- defaults follow the operating system, and nothing flashes
    const recorder = () => {
      window.__themeLog = [];
      new MutationObserver((recs) => { for (const r of recs) window.__themeLog.push({ v: document.documentElement.getAttribute('data-theme'), body: !!document.body }); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    };
    for (const os of ['light', 'dark']) {
      const ctx = await browser.newContext({ colorScheme: os, viewport: { width: 1280, height: 900 } });
      const p = await ctx.newPage(); await p.addInitScript(recorder);
      await p.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
      check(`OS ${os}, nothing saved: login page is ${os}`, (await theme(p)) === os && (await pref(p)) === 'system');
      check(`OS ${os}: page background matches (${os})`, (await bodyBg(p)) === (os === 'dark' ? DARK_CANVAS : LIGHT_CANVAS));
      const log = await p.evaluate(() => window.__themeLog);
      check(`OS ${os}: theme is decided in <head>, before the body exists, and never changes afterwards`, log.every((x) => x.body === false) && new Set(log.map((x) => x.v)).size <= 1 && (log.length === 0 || log[log.length - 1].v === os), JSON.stringify(log));
      if (os === 'dark') await p.screenshot({ path: shots('login-dark.png') }); else await p.screenshot({ path: shots('login-light.png') });
      await ctx.close();
    }
    // explicit choice beats the OS, and also does not flash after a reload
    {
      const ctx = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 900 } });
      const p = await ctx.newPage(); await p.addInitScript(recorder);
      await p.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
      await p.click('[data-testid="auth-theme-dark"]');
      check('sign-in page: choosing Dark applies at once and is saved on this device', (await theme(p)) === 'dark' && (await stored(p)) === 'dark');
      await p.reload({ waitUntil: 'networkidle' });
      const log = await p.evaluate(() => window.__themeLog);
      check('explicit Dark with a light OS: still dark after reload, no flash', (await theme(p)) === 'dark' && log.every((x) => x.body === false && x.v === 'dark'), JSON.stringify(log));
      for (const url of ['/forgot-password', '/reset-password?token=x', '/activate?token=x']) {
        await p.goto(`${WEB}${url}`, { waitUntil: 'networkidle' });
        check(`public page ${url.split('?')[0]} honours the saved theme`, (await theme(p)) === 'dark' && (await bodyBg(p)) === DARK_CANVAS);
      }
      await ctx.close();
    }

    // --- signed-in: selector in the profile menu and the profile page
    const ctx = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await signIn(page, stu.email); await page.waitForURL('**/dashboard');
    check('first sign-in with nothing chosen anywhere: follows the OS (light)', (await theme(page)) === 'light');
    await page.click('[data-testid="nav-avatar-menu-button"]');
    await page.waitForSelector('[data-testid="profile-menu"]');
    check('profile menu offers Light, Dark and System', (await page.locator('[data-testid^="menu-theme-"]').count()) === 3);
    check('profile menu has the profile link and sign out', (await page.locator('[data-testid="menu-profile"]').count()) === 1 && (await page.locator('[data-testid="menu-signout"]').count()) === 1);
    await page.click('[data-testid="menu-theme-dark"]');
    check('menu: Dark applies instantly', (await theme(page)) === 'dark' && (await page.getAttribute('[data-testid="menu-theme-dark"]', 'aria-checked')) === 'true');
    check('menu: choice is saved to the account', await waitDb(stu.id, 'dark'));
    check('menu: and kept on this device', (await stored(page)) === 'dark');
    await page.screenshot({ path: shots('menu-dark.png') });
    await page.keyboard.press('Escape');
    check('Escape closes the menu', (await page.locator('[data-testid="profile-menu"]').count()) === 0);
    await page.goto(`${WEB}/profile`, { waitUntil: 'networkidle' });
    check('profile page Appearance card reflects the choice', (await page.getAttribute('[data-testid="appearance-theme-dark"]', 'aria-checked')) === 'true' && /Always dark/.test(await page.textContent('[data-testid="appearance-status"]')));
    await page.click('[data-testid="appearance-theme-light"]');
    check('profile page: Light applies and syncs', (await theme(page)) === 'light' && (await waitDb(stu.id, 'light')));
    await page.click('[data-testid="appearance-theme-system"]');
    check('profile page: System saves "system"', (await waitDb(stu.id, 'system')) && (await pref(page)) === 'system');

    // --- System mode is live
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
    check('System mode: OS switches to dark -> the app follows without a reload', (await bodyBg(page)) === DARK_CANVAS);
    check('System mode: status text says it is following the device', /Following your device — currently dark/.test(await page.textContent('[data-testid="appearance-status"]')));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
    check('System mode: OS switches back to light -> the app follows', (await bodyBg(page)) === LIGHT_CANVAS);
    await page.click('[data-testid="appearance-theme-light"]');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(400);
    check('explicit Light ignores OS changes', (await theme(page)) === 'light');
    await page.emulateMedia({ colorScheme: 'light' });

    // --- another tab follows
    const tab2 = await ctx.newPage(); await tab2.goto(`${WEB}/profile`, { waitUntil: 'networkidle' });
    await page.click('[data-testid="appearance-theme-dark"]');
    await tab2.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
    check('a second open tab follows the change', true);
    await tab2.close();

    // --- another device: new browser, account preference is adopted at sign-in
    await waitDb(stu.id, 'dark');
    const dev2 = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 900 } });
    const d2 = await dev2.newPage();
    await signIn(d2, stu.email); await d2.waitForURL('**/dashboard');
    await d2.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
    check('another device: account preference (dark) is applied after sign-in', (await stored(d2)) === 'dark');
    // account wins over a different local choice
    await pool.query(`UPDATE users SET theme_preference='light' WHERE id=$1`, [stu.id]);
    await d2.click('[data-testid="nav-avatar-menu-button"]'); await d2.click('[data-testid="menu-signout"]'); await d2.waitForURL('**/login');
    check('signing out keeps this device\'s choice for the login page', (await theme(d2)) === 'dark');
    await signIn(d2, stu.email); await d2.waitForURL('**/dashboard');
    await d2.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
    check('account preference wins over this device\'s older local choice', (await stored(d2)) === 'light');
    // account without a preference takes the device's choice
    await pool.query(`UPDATE users SET theme_preference=NULL WHERE id=$1`, [stu2.id]);
    const dev3 = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 900 } });
    const d3 = await dev3.newPage();
    await d3.goto(`${WEB}/login`, { waitUntil: 'networkidle' }); await d3.click('[data-testid="auth-theme-dark"]');
    await signIn(d3, stu2.email); await d3.waitForURL('**/dashboard');
    check('no account preference yet: the choice made on the login page is saved to the account', await waitDb(stu2.id, 'dark'));
    check('and stays dark after sign-in', (await theme(d3)) === 'dark');
    await dev2.close(); await dev3.close();

    // --- phone width
    const mob = await browser.newContext({ colorScheme: 'dark', viewport: { width: 390, height: 800 } });
    const mp = await mob.newPage();
    await signIn(mp, stu.email); await mp.waitForURL('**/dashboard');
    await mp.click('[data-testid="nav-avatar-menu-button"]');
    await mp.waitForSelector('[data-testid="profile-menu"]');
    const box = await mp.locator('[data-testid="profile-menu"]').boundingBox();
    check('phone: profile menu fits on screen in dark mode', box.x >= 0 && box.x + box.width <= 390);
    check('phone: page does not scroll sideways', !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    await mp.screenshot({ path: shots('mobile-menu-dark.png') });
    await mob.close();

    // ================= charts =================
    {
      const c = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 1000 } });
      const p = await c.newPage();
      await signIn(p, fac.email); await p.waitForURL((u) => u.pathname === '/faculty');
      await p.goto(`${WEB}/analytics`, { waitUntil: 'networkidle' });
      await p.waitForSelector('.recharts-surface');
      const axisLight = await p.evaluate(() => getComputedStyle(document.querySelector('.recharts-cartesian-axis-tick-value')).fill);
      await p.evaluate(() => localStorage.setItem('sarp-theme', 'dark')); await p.reload({ waitUntil: 'networkidle' });
      await p.waitForSelector('.recharts-surface');
      const axisDark = await p.evaluate(() => getComputedStyle(document.querySelector('.recharts-cartesian-axis-tick-value')).fill);
      check('charts: axis labels change with the theme', axisLight !== axisDark && axisDark === 'rgb(160, 176, 171)', `${axisLight} -> ${axisDark}`);
      const bars = await p.evaluate(() => [...document.querySelectorAll('.recharts-bar-rectangle path, .recharts-pie-sector path')].map((e) => e.getAttribute('fill')));
      check('charts: no bar or slice uses the dark-navy fill that disappears on a dark card', bars.length > 0 && !bars.some((f) => (f || '').toUpperCase() === '#1E3150'), JSON.stringify(bars.slice(0, 5)));
      await c.close();
    }

    // ================= contrast audit (both themes, every page) =================
    const auditPage = async (label, page, theme_) => {
      await page.waitForTimeout(250);
      const r = await page.evaluate(AUDIT);
      auditResults.push({ label: `${label} [${theme_}]`, ...r });
      return r;
    };
    for (const th of (process.env.SKIP_AUDIT ? [] : ['light', 'dark'])) {
      // the account's saved choice would override the device's, so make both agree for this pass
      await pool.query('UPDATE users SET theme_preference = $1 WHERE id = ANY($2)', [th, userIds]);
      const mk = async (w = 1280) => { const c = await browser.newContext({ colorScheme: th, viewport: { width: w, height: 1000 } }); await c.addInitScript((t) => { try { localStorage.setItem('sarp-theme', t); } catch (e) { /* */ } }, th); return c; };
      // public pages
      let c = await mk(); let p = await c.newPage();
      for (const u of ['/login', '/forgot-password', '/reset-password?token=x', '/activate?token=x']) { await p.goto(`${WEB}${u}`, { waitUntil: 'networkidle' }); await auditPage(u, p, th); }
      await p.goto(`${WEB}/login/student`, { waitUntil: 'networkidle' }); await p.fill('input[type="email"]', 'nobody@x.test'); await p.fill('input[type="password"]', 'wrong-password1'); await p.click('button[type="submit"]'); await p.waitForSelector('[role="alert"]'); await auditPage('/login (error shown)', p, th);
      await c.close();
      // student
      c = await mk(); p = await c.newPage(); await signIn(p, stu.email); await p.waitForURL('**/dashboard'); await p.waitForSelector('text=Theme approved');
      await auditPage('student dashboard', p, th); if (th === 'dark') await p.screenshot({ path: shots('student-dashboard-dark.png'), fullPage: true });
      const newBtn = p.locator('button:has-text("New Activity"), button:has-text("Add Activity"), button:has-text("Submit Activity")').first();
      if (await newBtn.count()) { await newBtn.click().catch(() => {}); await auditPage('student: new-activity form', p, th); }
      for (const k of ['approved', 'rejected', 'correction', 'pending']) { await p.goto(`${WEB}/activity/${acts[k].id}`, { waitUntil: 'networkidle' }); await p.waitForSelector('h1,h2'); await auditPage(`activity (${k})`, p, th); if (th === 'dark' && k === 'rejected') await p.screenshot({ path: shots('activity-rejected-dark.png'), fullPage: true }); }
      for (const u of ['/portfolio', '/profile', '/notifications', '/support']) { await p.goto(`${WEB}${u}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(400); await auditPage(u, p, th); if (th === 'dark') await p.screenshot({ path: shots(`student${u.replace('/', '-')}-dark.png`), fullPage: true }); }
      await p.click('[data-testid="bell"]'); await p.waitForSelector('[data-testid="notif-popover"]'); await auditPage('notification popover', p, th); await p.keyboard.press('Escape');
      await p.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' }); await p.click('[data-testid="nav-avatar-menu-button"]'); await auditPage('profile menu', p, th);
      await c.close();
      // faculty
      c = await mk(); p = await c.newPage(); await signIn(p, fac.email); await p.waitForURL((u) => u.pathname === '/faculty'); await p.waitForSelector('[data-testid="filter-bar"]');
      await auditPage('faculty queue', p, th); if (th === 'dark') await p.screenshot({ path: shots('faculty-dark.png'), fullPage: true });
      const open = p.locator('button:has-text("Review Evidence")').first(); if (await open.count()) { await open.click(); await p.waitForSelector('[data-testid="review-modal"]'); await auditPage('faculty review modal', p, th); if (th === 'dark') await p.screenshot({ path: shots('review-modal-dark.png') }); await p.keyboard.press('Escape'); }
      await p.goto(`${WEB}/analytics`, { waitUntil: 'networkidle' }); await p.waitForSelector('.recharts-surface'); await auditPage('analytics', p, th); if (th === 'dark') await p.screenshot({ path: shots('analytics-dark.png'), fullPage: true });
      await c.close();
      // admin
      c = await mk(); p = await c.newPage(); await signIn(p, adm.email); await p.waitForURL((u) => u.pathname === '/admin'); await p.waitForSelector('[data-testid="overview-tiles"]');
      await auditPage('admin overview', p, th); if (th === 'dark') await p.screenshot({ path: shots('admin-dark.png'), fullPage: true });
      for (const label of ['users', 'import', 'faculty', 'academic', 'support', 'audit']) {
        const b = p.locator(`[data-testid="nav-admin-${label}"]`);
        if (await b.count()) { await b.click(); await p.waitForTimeout(600); if (label === 'support') { const t1 = p.locator('[data-testid^="admin-ticket-"] button').first(); if (await t1.count()) { await t1.click(); await p.waitForSelector('[data-testid="ticket-detail"]'); } } await auditPage(`admin ${label}`, p, th); if (th === 'dark') await p.screenshot({ path: shots(`admin-${label}-dark.png`), fullPage: true }); }
      }
      await c.close();
    }
    const totalChecked = auditResults.reduce((a, r) => a + r.checked, 0);
    const failing = auditResults.filter((r) => r.fails.length);
    console.log(`\nCONTRAST AUDIT: ${auditResults.length} page states, ${totalChecked} text elements checked`);
    for (const r of failing) { console.log(`  ${r.label}: ${r.fails.length} below WCAG AA`); for (const f of r.fails.slice(0, 6)) console.log(`     ${f.ratio} (<${f.need}) "${f.text}"  ${f.el}  ${f.fg}`); }
    if (auditResults.length) {
      check(`contrast audit: every text element on ${auditResults.length} page states meets WCAG AA`, failing.length === 0, `${failing.reduce((a, r) => a + r.fails.length, 0)} failures`);
      check('contrast audit covered a meaningful amount of text', totalChecked > 1500, String(totalChecked));
    }
  } catch (e) {
    console.error('E2E ERROR', e.message.split('\n')[0]);
    try { for (const [i, pg] of browser.contexts().flatMap((c) => c.pages()).entries()) { await pg.screenshot({ path: path.join(out, `fail-${i}.png`) }); console.error('PAGE', i, pg.url()); } } catch (_) { /* best effort */ }
    results.push({ name: 'script completed', ok: false });
  } finally {
    await browser.close();
    const q = (sql, p = []) => pool.query(sql, p).catch(() => {});
    await q('DELETE FROM activities WHERE student_id = ANY($1)', [userIds]);
    await q('DELETE FROM support_tickets WHERE user_id = ANY($1)', [userIds]);
    await q('DELETE FROM notifications WHERE user_id = ANY($1)', [userIds]);
    await q('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
