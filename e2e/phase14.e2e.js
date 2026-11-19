// Phase 14: the five end-to-end workflows (A-E), driven through the browser UI, with every key claim verified in the database.
// One continuous story: admin imports a student (C) and creates a faculty reviewer (D); the student submits and gets approved (A),
// has a correction cycle (B), then personalises the account and raises a support ticket that the admin handles (E).
// Needs PostgreSQL, backend :5001, frontend :3000.   node e2e/phase14.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const PASSWORD = 'E2ePass@12345';
const tag = `w14${Date.now()}`;
const TAG_U = tag.toUpperCase();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots14';
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };
const step = (s) => console.log(`\n== ${s}`);
const q1 = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const CSE = 'Computer Science & Engineering';

const makeFile = (name, kind = 'pdf') => {
  const p = path.join(out, `${tag}-${name}`);
  const head = kind === 'pdf' ? Buffer.from('%PDF-1.4\n%') : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(p, Buffer.concat([head, crypto.randomBytes(96)]));
  return p;
};
async function signIn(page, portal, email, password = PASSWORD) {
  await page.goto(`${WEB}/login/${portal}`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
const home = (role) => (u) => u.pathname === ({ student: '/dashboard', faculty: '/faculty', admin: '/admin' })[role];
const toast = async (page, re) => { await page.waitForSelector('.toast'); return re.test(await page.textContent('.toast')); };
const queueFind = async (page, text) => {
  await page.goto(`${WEB}/faculty`, { waitUntil: 'networkidle' });
  await page.fill('input[aria-label="Search records"]', tag);
  await page.waitForSelector(`text=${text}`, { timeout: 15000 });
};

(async () => {
  const adminEmail = `${tag}.admin@college.test`;
  const adminId = (await q1(`INSERT INTO users (name,email,password_hash,role,status,is_active,department,is_super_admin)
    VALUES ($1,$2,$3,'admin','ACTIVE',true,$4,true) RETURNING id`, [`Workflow Admin ${tag}`, adminEmail, await bcrypt.hash(PASSWORD, 4), CSE])).id;
  const stuEmail = `${tag}.student@college.test`; const facEmail = `${tag}.faculty@college.test`;
  const browser = await chromium.launch();
  const mk = async () => (await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true })).newPage();
  let stuId; let facId; const actIds = [];
  try {
    const admin = await mk();
    await signIn(admin, 'admin', adminEmail); await admin.waitForURL(home('admin'));

    // ================= Workflow C: admin imports students -> activation -> login =================
    step('Workflow C: import student, activate, sign in');
    await admin.click('[data-testid="nav-admin-import"]');
    const csv = path.join(out, `${tag}-students.csv`);
    fs.writeFileSync(csv, `student_id,name,email,department,programme,academic_year,semester\n${TAG_U}-S1,Workflow Student ${tag},${stuEmail},CSE,BTech,2025-26,3\n${TAG_U}-S2,Bad Row,not-an-email,CSE,BTech,2025-26,3\n`);
    await admin.setInputFiles('[data-testid="csv-input"]', csv);
    await admin.click('button:has-text("Preview import")');
    await admin.waitForSelector('[data-testid="import-preview"]');
    const prev = await admin.textContent('[data-testid="import-preview"]');
    check('C: preview shows 1 valid row and 1 rejected row with a reason', /Valid\s*1/.test(prev) && /Errors\s*1/.test(prev), prev.slice(0, 160));
    check('C: nothing is created by a preview', !(await q1('SELECT id FROM users WHERE email = $1', [stuEmail])));
    await admin.click('button:has-text("Import 1 valid row")');
    await admin.waitForSelector('[data-testid="import-result"]');
    let stu = await q1('SELECT id, role, status, department, enrollment_no, password_hash IS NULL AS no_pw FROM users WHERE email = $1', [stuEmail]);
    stuId = stu?.id;
    check('C: student exists as INVITED with no password and the right department', stu && stu.role === 'student' && stu.status === 'INVITED' && stu.no_pw && stu.department === CSE, JSON.stringify(stu));
    check('C: the bad row was not imported', !(await q1('SELECT id FROM users WHERE email = $1', ['not-an-email'])));
    check('C: import is in the admin audit log', !!(await q1(`SELECT id FROM admin_audit_log WHERE actor_id = $1 AND action ILIKE '%import%'`, [adminId])));
    await admin.screenshot({ path: path.join(out, 'C1-import-done.png') });

    const s = await mk();
    await s.goto(`${WEB}/register`, { waitUntil: 'networkidle' });
    await s.fill('#r-id', `${TAG_U}-S1`); await s.fill('#r-email', stuEmail); await s.fill('#r-name', `Workflow Student ${tag}`);
    await s.click('button:has-text("Request activation")');
    await s.waitForSelector('[role="status"], [role="alert"]');
    const regMsg = await s.textContent('main');
    check('C: self-activation request is accepted for a rostered student and does not claim an email was sent when none is configured', !/error|not found/i.test(regMsg) && !/we have emailed|email has been sent/i.test(regMsg), regMsg.slice(0, 200));
    await s.goto(`${WEB}/login/student`, { waitUntil: 'networkidle' });
    await s.fill('input[type="email"]', stuEmail); await s.fill('input[type="password"]', PASSWORD); await s.click('[data-testid="login-submit"]');
    await s.waitForTimeout(1500);
    check('C: an INVITED student cannot sign in before activating (still on login, no session)', new URL(s.url()).pathname.startsWith('/login') && !(await s.evaluate(() => localStorage.getItem('token'))));

    await admin.click('[data-testid="nav-admin-users"]');
    await admin.fill('input[placeholder*="Search"]', tag);
    await admin.waitForSelector(`text=${stuEmail}`);
    await admin.locator('button:has-text("Activation link")').first().click();
    const link = await admin.inputValue('[data-testid="one-time-link"]');
    check('C: hand-off activation link carries the token in the URL fragment', link.includes('#token='));
    await admin.click('button:has-text("Done")');
    await s.goto(link);
    await s.fill('#pw', PASSWORD); await s.fill('#pw2', PASSWORD); await s.click('button[type="submit"]');
    await s.waitForURL(/login/, { timeout: 15000 }).catch(() => {});
    stu = await q1('SELECT status, password_hash IS NOT NULL AS has_pw FROM users WHERE id = $1', [stuId]);
    check('C: after activation the student is ACTIVE with a (hashed) password', stu.status === 'ACTIVE' && stu.has_pw);
    await signIn(s, 'student', stuEmail); await s.waitForURL(home('student'));
    check('C: student signs in through the Student portal and lands on the dashboard', true);
    const reuse = await (await fetch('http://localhost:5001/auth/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: link.split('#token=')[1], password: PASSWORD }) })).status;
    check('C: the activation link cannot be used a second time', reuse >= 400 && reuse < 500, String(reuse));

    // ================= Workflow D: admin creates faculty -> activation -> login -> queue =================
    step('Workflow D: create faculty, activate, sign in, see queue');
    await admin.click('[data-testid="nav-admin-faculty"]');
    await admin.click('[data-testid="add-faculty"]');
    await admin.fill('#ff-id', `${TAG_U}-F1`); await admin.fill('#ff-name', `Prof Workflow ${tag}`); await admin.fill('#ff-email', facEmail);
    await admin.selectOption('#ff-dept', { label: CSE }); await admin.fill('#ff-desig', 'Associate Professor');
    await admin.click('button:has-text("Add faculty"):not([data-testid])');
    await admin.waitForSelector('[role="status"]');
    const fac = await q1(`SELECT id, role, status FROM users WHERE email = $1`, [facEmail]);
    facId = fac?.id;
    check('D: faculty account is created as INVITED faculty', fac && fac.role === 'faculty' && fac.status === 'INVITED', JSON.stringify(fac));
    const scope = (await pool.query('SELECT department FROM faculty_scopes WHERE faculty_id = $1', [facId])).rows.map((r) => r.department);
    check('D: default verification scope is the faculty member\'s own department', scope.length === 1 && scope[0] === CSE, JSON.stringify(scope));
    await admin.fill('input[aria-label="Search faculty"]', tag);
    await admin.waitForSelector(`text=${facEmail}`);
    await admin.click('button:has-text("Activation link")');
    const flink = await admin.inputValue('[data-testid="one-time-link"]');
    await admin.click('button:has-text("Done")');
    const f = await mk();
    await f.goto(flink);
    await f.fill('#pw', PASSWORD); await f.fill('#pw2', PASSWORD); await f.click('button[type="submit"]');
    await f.waitForURL(/login/, { timeout: 15000 }).catch(() => {});
    // the Student portal must not accept a faculty account
    await f.goto(`${WEB}/login/student`, { waitUntil: 'networkidle' });
    await f.fill('input[type="email"]', facEmail); await f.fill('input[type="password"]', PASSWORD); await f.click('[data-testid="login-submit"]');
    await f.waitForTimeout(1500);
    check('D: the faculty account is refused at the Student portal (still on login, no session)', new URL(f.url()).pathname === '/login/student' && !(await f.evaluate(() => localStorage.getItem('token'))));
    await signIn(f, 'faculty', facEmail); await f.waitForURL(home('faculty'));
    await f.waitForSelector('[data-testid="scope-banner"]');
    check('D: faculty lands on the verification queue showing the CSE scope', new RegExp('Computer Science').test(await f.textContent('[data-testid="scope-banner"]')));
    check('D: faculty sidebar has verification + analytics but no student items', (await f.locator('[data-testid="nav-verification"]').count()) === 1 && (await f.locator('[data-testid="nav-portfolio"]').count()) === 0);

    // ================= Workflow A: submit with proof -> faculty approves -> portfolio =================
    step('Workflow A: submit, approve, portfolio');
    const titleA = `Hackathon ${tag}`;
    await s.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
    await s.waitForSelector('[data-testid="activity-form"]');
    await s.fill('#af-title', titleA); await s.selectOption('#af-category', 'hackathon'); await s.fill('#af-date', '2026-01-15'); await s.selectOption('#af-sem', '3');
    await s.fill('#af-desc', 'Built an attendance app with a three person team.');
    await s.setInputFiles('[data-testid="proof-input"]', makeFile('proofA.pdf'));
    await s.click('button:has-text("Submit for Verification")');
    await s.waitForFunction(() => /submitted/i.test(document.querySelector('.toast')?.textContent || ''));
    const A = await q1(`SELECT id, status, version, file_hash, proof_file_path, proof_mime_type FROM activities WHERE student_id = $1 AND title = $2`, [stuId, titleA]);
    actIds.push(A?.id);
    check('A: activity is stored as pending v1 with a proof file recorded', !!A && A.status === 'pending' && A.version === 1 && !!A.proof_file_path, JSON.stringify(A));
    check('A: a SHA-256 digest was recorded for the proof', /^[0-9a-f]{64}$/.test(A?.file_hash || ''));
    const stuTok = await s.evaluate(() => localStorage.getItem('token'));
    const selfApprove = await fetch(`http://localhost:5001/activities/${A.id}/approve`, { method: 'PATCH', headers: { 'content-type': 'application/json', Authorization: `Bearer ${stuTok}` }, body: '{}' });
    check('A: the student cannot approve their own work (API returns 403, record unchanged)', selfApprove.status === 403 && (await q1('SELECT status FROM activities WHERE id = $1', [A.id])).status === 'pending', String(selfApprove.status));
    await queueFind(f, titleA);
    check('A: faculty sees the new submission in the queue', true);
    await f.click(`[data-testid="review-${A.id}"]`);
    await f.waitForSelector('[data-testid="review-modal"]');
    await f.waitForFunction((h) => (document.querySelector('[data-testid="review-modal"]')?.textContent || '').includes(h), A.file_hash).catch(() => {});
    check('A: faculty sees the proof\'s SHA-256 digest in the review window', (await f.textContent('[data-testid="review-modal"]')).includes(A.file_hash));
    await f.click('[data-testid="preview-proof"]');
    await f.waitForSelector('[data-testid="proof-preview"]');
    check('A: faculty can open the proof through the authenticated preview', true);
    await f.click('[data-testid="decision-approve"]');
    await f.waitForFunction(() => !document.querySelector('[data-testid="review-modal"]'));
    const A2 = await q1('SELECT status, reviewer_id FROM activities WHERE id = $1', [A.id]);
    check('A: approval stored with this reviewer', A2.status === 'approved' && A2.reviewer_id === facId, JSON.stringify(A2));
    const alog = await q1(`SELECT old_status, new_status, reviewer_id FROM audit_log WHERE activity_id = $1 ORDER BY id DESC LIMIT 1`, [A.id]);
    check('A: audit trail records pending -> approved by the reviewer', alog && alog.old_status === 'pending' && alog.new_status === 'approved' && alog.reviewer_id === facId, JSON.stringify(alog));
    check('A: student received an approval notification', !!(await q1(`SELECT id FROM notifications WHERE user_id = $1 AND (message ILIKE '%approved%' OR title ILIKE '%approved%')`, [stuId]).catch(() => null)));
    await s.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
    await s.waitForSelector(`text=${titleA}`);
    check('A: student sees the activity as verified', /verified|approved/i.test(await s.textContent('main')));
    await s.goto(`${WEB}/portfolio`, { waitUntil: 'networkidle' });
    await s.waitForSelector(`text=${titleA}`);
    check('A: the verified activity appears in the portfolio', true);
    const [dl] = await Promise.all([s.waitForEvent('download'), s.click('button:has-text("Download Portfolio PDF")')]);
    const pdfPath = path.join(out, `${tag}-portfolio.pdf`); await dl.saveAs(pdfPath);
    let pdfText = ''; try { pdfText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' }); } catch (e) { pdfText = ''; }
    check('A: downloaded portfolio is a real PDF', fs.readFileSync(pdfPath).slice(0, 4).toString() === '%PDF');
    check('A: the PDF contains the student, the approved title and the proof digest prefix', pdfText.includes(titleA) && pdfText.includes(`Workflow Student ${tag}`) && pdfText.includes(A.file_hash.slice(0, 8)), pdfText.slice(0, 200));
    await s.screenshot({ path: path.join(out, 'A-portfolio.png') });

    // ================= Workflow B: correction -> resubmit -> re-review -> audit =================
    step('Workflow B: correction cycle');
    const titleB = `Workshop ${tag}`;
    await s.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
    await s.waitForSelector('[data-testid="activity-form"]');
    await s.fill('#af-title', titleB); await s.selectOption('#af-category', 'workshop'); await s.fill('#af-date', '2026-02-10'); await s.selectOption('#af-sem', '3');
    await s.fill('#af-desc', 'Two day workshop on cloud basics.');
    await s.setInputFiles('[data-testid="proof-input"]', makeFile('proofB1.pdf'));
    await s.click('button:has-text("Submit for Verification")');
    await s.waitForFunction(() => /submitted/i.test(document.querySelector('.toast')?.textContent || ''));
    const B = await q1(`SELECT id FROM activities WHERE student_id = $1 AND title = $2`, [stuId, titleB]); actIds.push(B.id);
    await queueFind(f, titleB);
    await f.click(`[data-testid="review-${B.id}"]`); await f.waitForSelector('[data-testid="review-modal"]');
    await f.click('[data-testid="decision-correction"]');
    await f.waitForTimeout(500);
    check('B: a correction request without remarks is refused (activity unchanged)', (await q1('SELECT status FROM activities WHERE id = $1', [B.id])).status === 'pending');
    await f.fill('#review-remarks', 'The certificate scan is too dark to read.');
    await f.click('[data-testid="decision-correction"]');
    await f.waitForFunction(() => !document.querySelector('[data-testid="review-modal"]'));
    check('B: status is correction_requested with the reviewer\'s remark', await (async () => { const r = await q1('SELECT status, correction_notes, review_remarks FROM activities WHERE id = $1', [B.id]); return r.status === 'correction_requested' && /too dark/.test(`${r.correction_notes || ''}${r.review_remarks || ''}`); })());
    await s.goto(`${WEB}/activity/${B.id}`, { waitUntil: 'networkidle' });
    await s.waitForSelector('text=Faculty Correction Instructions');
    check('B: the student sees the instructions on the activity page', /too dark/.test(await s.textContent('main')));
    await s.click('button:has-text("Resubmit with Corrections")');
    await s.fill('#rs-title', `${titleB} (clear scan)`); await s.fill('#rs-note', 'Re-scanned at higher resolution.');
    await s.setInputFiles('[data-testid="resubmit-proof"]', makeFile('proofB2.png', 'png'));
    await s.click('button:has-text("Submit Corrections")');
    await s.waitForSelector('text=now version 2');
    const vers = (await pool.query('SELECT version, title FROM activity_versions WHERE activity_id = $1 ORDER BY version', [B.id])).rows;
    check('B: both versions are kept (v1 untouched, v2 corrected)', vers.length === 2 && vers[0].title === titleB && vers[1].title === `${titleB} (clear scan)`, JSON.stringify(vers));
    check('B: the status is now resubmitted', (await q1('SELECT status FROM activities WHERE id = $1', [B.id])).status === 'resubmitted');
    await queueFind(f, `${titleB} (clear scan)`);
    await f.click(`[data-testid="review-${B.id}"]`); await f.waitForSelector('[data-testid="review-history"] li');
    check('B: the reviewer sees the history of the earlier decision and version 2', /Version 2/.test(await f.textContent('[data-testid="review-modal"]')) && /too dark/.test(await f.textContent('[data-testid="review-history"]')));
    await f.click('[data-testid="decision-approve"]');
    await f.waitForFunction(() => !document.querySelector('[data-testid="review-modal"]'));
    check('B: re-review approves the resubmission', (await q1('SELECT status FROM activities WHERE id = $1', [B.id])).status === 'approved');
    const trail = (await pool.query('SELECT old_status, new_status, version FROM audit_log WHERE activity_id = $1 ORDER BY id', [B.id])).rows;
    const flow = trail.map((r) => `${r.old_status}>${r.new_status}`).join(' | ');
    check('B: audit trail shows the full journey in order', /pending>correction_requested/.test(flow) && /correction_requested>resubmitted/.test(flow) && /resubmitted>approved/.test(flow) && flow.indexOf('pending>correction_requested') < flow.indexOf('resubmitted>approved'), flow);
    check('B: audit rows are append-only (UPDATE and DELETE are blocked or leave the count unchanged)', await (async () => {
      const before = trail.length;
      await pool.query('UPDATE audit_log SET remarks = $2 WHERE activity_id = $1', [B.id, 'tampered']).catch(() => {});
      await pool.query('DELETE FROM audit_log WHERE activity_id = $1', [B.id]).catch(() => {});
      const after = (await pool.query('SELECT COUNT(*)::int n, bool_or(remarks = $2) t FROM audit_log WHERE activity_id = $1', [B.id, 'tampered'])).rows[0];
      return after.n === before && !after.t;
    })());

    // ================= Workflow E: photo -> theme -> support ticket -> admin manages =================
    step('Workflow E: photo, theme, support ticket, admin handling');
    await s.goto(`${WEB}/profile`, { waitUntil: 'networkidle' });
    const png = path.join(out, `${tag}-avatar.png`);
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    await s.setInputFiles('[data-testid="photo-input"]', png);
    await s.waitForSelector('[data-testid="photo-save"]'); await s.click('[data-testid="photo-save"]');
    await s.waitForFunction(() => document.querySelector('[data-testid="nav-avatar"]')?.getAttribute('data-kind') === 'photo');
    check('E: photo is saved and the top-bar avatar switches to it', true);
    await s.click('[data-testid="nav-avatar-menu-button"]'); await s.click('[data-testid="menu-theme-dark"]');
    await s.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
    await s.waitForTimeout(800);
    check('E: Dark theme is saved to the account in the database', (await q1('SELECT theme_preference FROM users WHERE id = $1', [stuId])).theme_preference === 'dark');
    await s.keyboard.press('Escape');
    await s.reload({ waitUntil: 'networkidle' });
    check('E: Dark theme persists after a reload', (await s.getAttribute('html', 'data-theme')) === 'dark');
    await s.screenshot({ path: path.join(out, 'E-profile-dark.png') });

    const subject = `Cannot download proof ${tag}`;
    await s.goto(`${WEB}/support`, { waitUntil: 'networkidle' });
    await s.selectOption('#t-category', { index: 1 });
    await s.fill('#t-subject', subject); await s.fill('#t-message', 'The proof file for my workshop does not open when I click it.');
    await s.click('[data-testid="ticket-submit"]');
    await s.waitForSelector('[data-testid="ticket-ref"]');
    const ref = (await s.textContent('[data-testid="ticket-ref"]')).trim();
    const T = await q1('SELECT status, user_id, email FROM support_tickets WHERE ticket_ref = $1', [ref]);
    check('E: ticket is stored OPEN for this student with their account email', T && T.status === 'OPEN' && T.user_id === stuId && T.email === stuEmail, JSON.stringify(T));
    await admin.click('[data-testid="nav-admin-support"]');
    await admin.fill('[data-testid="ticket-search"]', ref);
    await admin.waitForSelector(`[data-testid="admin-ticket-${ref}"]`);
    await admin.click(`[data-testid="admin-ticket-${ref}"] button`);
    await admin.waitForSelector('[data-testid="ticket-detail"]');
    check('E: admin sees the ticket message', /does not open/.test(await admin.textContent('[data-testid="ticket-message"]')));
    await admin.selectOption('[data-testid="detail-status"]', 'RESOLVED');
    await admin.fill('[data-testid="detail-notes"]', `INTERNAL-NOTE-${tag}: re-uploaded proof for the student`);
    await admin.click('[data-testid="detail-save"]');
    await admin.waitForSelector('[data-testid="detail-saved"]');
    const T2 = await q1('SELECT status, admin_notes FROM support_tickets WHERE ticket_ref = $1', [ref]);
    check('E: admin\'s status change and internal note are saved', T2.status === 'RESOLVED' && T2.admin_notes.includes('INTERNAL-NOTE'));
    await s.reload({ waitUntil: 'networkidle' });
    await s.waitForSelector(`[data-testid="ticket-${ref}"]`);
    const hist = await s.textContent(`[data-testid="ticket-${ref}"]`);
    check('E: student sees the ticket as Resolved', /Resolved/i.test(hist));
    const apiTok = await s.evaluate(() => localStorage.getItem('token'));
    const mine = await (await fetch('http://localhost:5001/support/tickets', { headers: { Authorization: `Bearer ${apiTok}` } })).text();
    check('E: the admin\'s internal note is never shown or sent to the student (page and API)', !(await s.content()).includes('INTERNAL-NOTE') && mine.includes(ref) && !mine.includes('INTERNAL-NOTE') && !mine.includes('admin_notes'), mine.slice(0, 120));
    await admin.screenshot({ path: path.join(out, 'E-admin-ticket.png') });
  } finally {
    await browser.close();
    const q = (sql, p = []) => pool.query(sql, p).catch(() => {});
    const uids = [adminId, stuId, facId].filter(Boolean);
    const acts = (await pool.query('SELECT id FROM activities WHERE student_id = ANY($1)', [uids]).catch(() => ({ rows: [] }))).rows.map((r) => r.id);
    const files = (await pool.query('SELECT proof_file_path p FROM activity_versions WHERE activity_id = ANY($1) UNION SELECT proof_file_path FROM activities WHERE id = ANY($1)', [acts]).catch(() => ({ rows: [] }))).rows;
    await q('DELETE FROM support_tickets WHERE user_id = ANY($1)', [uids]);
    await q('DELETE FROM audit_log WHERE activity_id = ANY($1)', [acts]);
    await q('DELETE FROM activity_versions WHERE activity_id = ANY($1)', [acts]);
    await q('DELETE FROM activities WHERE id = ANY($1)', [acts]);
    await q('DELETE FROM notifications WHERE user_id = ANY($1)', [uids]);
    await q('DELETE FROM faculty_scopes WHERE faculty_id = ANY($1)', [uids]);
    await q('DELETE FROM auth_tokens WHERE user_id = ANY($1)', [uids]);
    await q('DELETE FROM users WHERE id = ANY($1)', [uids]);
    for (const f of files) { if (f.p) { try { fs.unlinkSync(path.resolve(__dirname, '../backend', f.p)); } catch (e) { /* already gone */ } } }
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
