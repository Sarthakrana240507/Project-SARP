// Phase 6 browser test: faculty verification centre. Needs PostgreSQL, backend on :5001, frontend (next start) on :3000.
//   node e2e/phase6.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const API = 'http://localhost:5001';
const PASSWORD = 'E2ePass@12345';
const tag = `e6${Date.now()}`;
const DEPT = `E2E Dept ${tag}`; const OTHER = `E2E Other ${tag}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots6';
const UPLOADS = path.resolve(__dirname, '../backend/uploads');
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function dbUser(role, label, department) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const email = `${tag}.${label}@college.test`;
  const id = (await pool.query(
    `INSERT INTO users (name,email,password_hash,role,status,is_active,department,enrollment_no)
     VALUES ($1,$2,$3,$4,'ACTIVE',true,$5,$6) RETURNING id`,
    [`E2E ${label} ${tag}`, email, hash, role, department, role === 'student' ? `${tag}-${label}`.toUpperCase() : null])).rows[0].id;
  return { id, email };
}
async function addActivity(studentId, o) {
  const a = (await pool.query(
    `INSERT INTO activities (student_id,title,category,description,status,activity_date,academic_session,semester,version,
        file_hash,proof_file_path,proof_original_name,proof_mime_type,proof_size,is_duplicate,duplicate_of,reviewer_id,reviewed_at,review_remarks,correction_notes,resubmitted_at)
     VALUES ($1,$2,$3,'E2E description',$4,'2026-01-10',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [studentId, o.title, o.category || 'hackathon', o.status || 'pending', o.year || '2025-2026', o.sem || '5', o.version || 1,
      o.hash || crypto.randomBytes(16).toString('hex'), o.file || null, o.file ? 'certificate.png' : null, o.file ? 'image/png' : null, o.file ? PNG_1X1.length : null,
      Boolean(o.dupOf), o.dupOf || null, o.reviewer || null, o.reviewedAt || null, o.remarks || null, o.corr || null, o.resubmittedAt || null])).rows[0].id;
  await pool.query(`INSERT INTO activity_versions (activity_id, version, title, category, description, academic_session, semester, file_hash, created_at)
                    VALUES ($1,$2,$3,$4,'E2E description',$5,$6,$7, COALESCE($8::timestamp, NOW()))`,
    [a, o.version || 1, o.title, o.category || 'hackathon', o.year || '2025-2026', o.sem || '5', o.hash || null, o.submittedAt || null]);
  return a;
}
const audit = (activityId, studentId, reviewerId, from, to, remarks, version) => pool.query(
  `INSERT INTO audit_log (activity_id,student_id,reviewer_id,old_status,new_status,remarks,version) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [activityId, studentId, reviewerId, from, to, remarks, version]);

async function signIn(page, email) {
  // sign in through the portal that matches the account (the server also checks the role)
  const { rows: [who] } = await pool.query('SELECT role FROM users WHERE email = $1', [email]);
  await page.goto(`${WEB}/login/${who.role}`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
}
const apiToken = async (email) => (await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) })).json()).token;
const statValue = async (page, id) => Number(await page.textContent(`[data-testid="stat-value-${id}"]`));

(async () => {
  const browser = await chromium.launch();
  const userIds = []; const files = [];
  try {
    const fac = await dbUser('faculty', 'fac', DEPT); const fac2 = await dbUser('faculty', 'fac2', DEPT);
    const s1 = await dbUser('student', 's1', DEPT); const s2 = await dbUser('student', 's2', DEPT); const s3 = await dbUser('student', 's3', OTHER);
    userIds.push(fac.id, fac2.id, s1.id, s2.id, s3.id);
    for (const f of [fac, fac2]) await pool.query('INSERT INTO faculty_scopes (faculty_id, department) VALUES ($1, $2)', [f.id, DEPT]);

    // 13 plain queue items (one submitted long ago), 2 sharing a file, 1 resubmitted after a correction, 1 in another department
    const items = [];
    for (let i = 1; i <= 13; i++) {
      items.push(await addActivity(i % 2 ? s1.id : s2.id, {
        title: `Queue Item ${String(i).padStart(2, '0')}`, category: i % 2 ? 'hackathon' : 'workshop',
        year: i <= 6 ? '2024-2025' : '2025-2026', sem: i <= 6 ? '3' : '5',
        submittedAt: i === 13 ? '2025-03-10 10:00:00' : null,
      }));
    }
    const pngName = path.join(UPLOADS, `${tag}-proof.png`); fs.writeFileSync(pngName, PNG_1X1); files.push(pngName);
    const sharedHash = crypto.randomBytes(32).toString('hex');
    const dupA = await addActivity(s1.id, { title: 'Original Certificate', hash: sharedHash, category: 'certification' });
    const dupB = await addActivity(s2.id, { title: 'Same Certificate Again', hash: sharedHash, category: 'certification', dupOf: dupA, file: pngName });
    const resub = await addActivity(s1.id, { title: 'Corrected Internship', status: 'resubmitted', version: 2, category: 'internship', resubmittedAt: '2026-02-01 09:00:00' });
    await audit(resub, s1.id, null, 'draft', 'pending', 'Submitted', 1);
    await audit(resub, s1.id, fac.id, 'pending', 'correction_requested', 'Please add the company letterhead', 1);
    await audit(resub, s1.id, null, 'correction_requested', 'resubmitted', 'Added the letterhead', 2);
    const hidden = await addActivity(s3.id, { title: 'Other Dept Secret', status: 'pending' });
    const approved = await addActivity(s1.id, { title: 'Past Approved', status: 'approved', reviewer: fac2.id, reviewedAt: '2026-02-03 10:00:00' });
    const rejected = await addActivity(s2.id, { title: 'Past Rejected', status: 'rejected', reviewer: fac.id, reviewedAt: '2026-02-04 10:00:00', remarks: 'Illegible scan' });
    await audit(approved, s1.id, fac2.id, 'pending', 'approved', null, 1);
    await audit(rejected, s2.id, fac.id, 'pending', 'rejected', 'Illegible scan', 1);

    const ctx = await browser.newContext({ viewport: { width: 1360, height: 1100 } });
    const page = await ctx.newPage();
    await signIn(page, fac.email);
    await page.waitForURL((u) => u.pathname === '/faculty');
    await page.waitForSelector('[data-testid="review-stats"]');
    await page.waitForFunction(() => /^\d+$/.test(document.querySelector('[data-testid="stat-value-pending"]')?.textContent || ''));

    // ---- dashboard numbers
    const want = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('pending','resubmitted'))::int p, COUNT(*) FILTER (WHERE status='approved')::int a,
              COUNT(*) FILTER (WHERE status='rejected')::int r, COUNT(*) FILTER (WHERE status='correction_requested')::int c,
              COUNT(*) FILTER (WHERE status IN ('pending','resubmitted') AND is_duplicate)::int d
       FROM activities WHERE student_id = ANY($1)`, [[s1.id, s2.id]])).rows[0];
    check('dashboard tiles match the database (scope only)',
      (await statValue(page, 'pending')) === want.p && (await statValue(page, 'approved')) === want.a && (await statValue(page, 'rejected')) === want.r
      && (await statValue(page, 'correction_requested')) === want.c && (await statValue(page, 'duplicate_warnings')) === want.d, JSON.stringify(want));
    check('pending tile excludes the other department (16, not 17)', want.p === 16 && (await statValue(page, 'pending')) === 16);
    check('recently reviewed list shows the latest decisions first', /Past Rejected[\s\S]*Past Approved/.test(await page.textContent('[data-testid="recent-reviews"]')));

    // ---- paging + scope
    check('queue pages at 10 of 16', /Page 1 of 2/.test(await page.textContent('[data-testid="pagination"]')) && (await page.locator('[data-testid^="row-"]').count()) === 10);
    await page.click('[data-testid="pagination"] button:has-text("Next")');
    await page.waitForFunction(() => /Page 2 of 2/.test(document.querySelector('[data-testid="pagination"]')?.textContent || ''));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length === 6, null, { timeout: 5000 }).catch(() => {});
    check('page 2 has the remaining 6', (await page.locator('[data-testid^="row-"]').count()) === 6);
    await page.click('[data-testid="pagination"] button:has-text("Previous")');
    const deptOptions = await page.locator('select[aria-label="Department"] option').allTextContents();
    check('department filter lists only my scope', deptOptions.some((d) => d === DEPT) && !deptOptions.includes(OTHER), deptOptions.join('|'));

    // ---- every filter reaches the server
    const req = (re) => page.waitForRequest((r) => r.url().includes('/activities/pending') && re.test(r.url()));
    let [r] = await Promise.all([req(/search=Queue(\+|%20)Item(\+|%20)05/), page.fill('input[aria-label="Search records"]', 'Queue Item 05')]);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length === 1);
    check('search is sent to the server and narrows to one row', r.url().includes('search=') && (await page.locator('[data-testid^="row-"]').count()) === 1);
    await page.fill('input[aria-label="Search records"]', 'Other Dept Secret');
    await page.waitForSelector('text=No matching records');
    check('a student outside my scope can never be found', true === ((await page.locator('[data-testid^="row-"]').count()) === 0));
    await page.fill('input[aria-label="Search records"]', `${tag}-s2`); // by enrolment number
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length > 0);
    check('search by enrolment number works', (await page.locator('text=Same Certificate Again').count()) === 1);
    await page.click('[data-testid="reset-filters"]');
    await page.waitForSelector('[data-testid="pagination"]');

    [r] = await Promise.all([req(/category=workshop/), page.selectOption('select[aria-label="Category"]', 'workshop')]);
    await page.waitForTimeout(500);
    const cats = await page.locator('[data-testid^="row-"]').allTextContents();
    check('category filter sent and applied', r.url().includes('category=workshop') && cats.length > 0 && cats.every((t) => /workshop/i.test(t)));
    [r] = await Promise.all([req(/academic_session=2024-2025/), page.selectOption('select[aria-label="Academic year"]', '2024-2025')]);
    await page.waitForTimeout(500);
    check('academic year filter sent', r.url().includes('academic_session=2024-2025'));
    [r] = await Promise.all([req(/semester=3/), page.selectOption('select[aria-label="Semester"]', '3')]);
    await page.waitForTimeout(500);
    check('semester filter sent; 3 workshop items from 2024-2025 sem 3', r.url().includes('semester=3') && (await page.locator('[data-testid^="row-"]').count()) === 3, String(await page.locator('[data-testid^="row-"]').count()));
    await page.click('[data-testid="reset-filters"]');
    [r] = await Promise.all([req(/status=resubmitted/), page.selectOption('select[aria-label="Status"]', 'resubmitted')]);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length === 1);
    check('status filter: only the resubmitted item', (await page.locator('text=Corrected Internship').count()) === 1);
    await page.click('[data-testid="reset-filters"]');
    [r] = await Promise.all([req(/date_to=2025-06-01/), page.fill('input[aria-label="Submitted to"]', '2025-06-01')]);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length === 1 && document.body.textContent.includes('Queue Item 13'));
    check('submission date filter finds the one old submission', (await page.locator('text=Queue Item 13').count()) === 1);
    await page.click('[data-testid="reset-filters"]');
    [r] = await Promise.all([req(/duplicate=true/), page.check('input[aria-label="Only duplicate warnings"]')]);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length === 1);
    check('duplicate-only filter shows the flagged item', (await page.locator('text=Same Certificate Again').count()) === 1);
    await page.click('[data-testid="reset-filters"]');
    const firstTitle = async () => (await page.locator('[data-testid^="row-"] h3').first().textContent());
    await page.waitForSelector('[data-testid="pagination"]');
    await page.waitForFunction(() => document.querySelector('[data-testid^="row-"] h3')?.textContent === 'Queue Item 13', null, { timeout: 5000 }).catch(() => {});
    const oldestFirst = await firstTitle();
    [r] = await Promise.all([req(/sort=newest/), page.selectOption('select[aria-label="Sort order"]', 'newest')]);
    await page.waitForTimeout(600);
    check('sort order is sent and changes the list', r.url().includes('sort=newest') && (await firstTitle()) !== oldestFirst, `${oldestFirst} -> ${await firstTitle()}`);
    check('oldest submission is first by default', oldestFirst === 'Queue Item 13', oldestFirst);
    await page.click('[data-testid="reset-filters"]');
    await page.screenshot({ path: path.join(out, '1-queue.png') });

    // ---- detailed review: duplicate warning, inline preview, empty history
    await page.fill('input[aria-label="Search records"]', 'Same Certificate Again');
    await page.waitForSelector(`[data-testid="review-${dupB}"]`);
    await page.click(`[data-testid="review-${dupB}"]`);
    await page.waitForSelector('[data-testid="duplicate-info"]');
    const dupText = await page.textContent('[data-testid="duplicate-info"]');
    check('duplicate warning names the earlier submission', /Original Certificate/.test(dupText) && /not treated as fraud/.test(dupText), dupText);
    check('SHA-256 digest is shown', (await page.textContent('[data-testid="review-modal"]')).includes(sharedHash));
    await page.click('[data-testid="preview-proof"]');
    await page.waitForSelector('[data-testid="proof-preview"] img');
    const src = await page.getAttribute('[data-testid="proof-preview"] img', 'src');
    const natural = await page.evaluate(() => document.querySelector('[data-testid="proof-preview"] img').complete && document.querySelector('[data-testid="proof-preview"] img').naturalWidth);
    check('proof preview renders the image inline', src.startsWith('blob:') && natural === 1, `${src} ${natural}`);
    check('modal says no earlier decision', /No decision has been recorded/.test(await page.textContent('[data-testid="review-history"]')));
    await page.screenshot({ path: path.join(out, '2-review-modal.png') });

    // ---- decision rules in the UI
    await page.click('[data-testid="decision-reject"]');
    check('reject without remarks is blocked with a message', /remark is mandatory/.test(await page.textContent('[data-testid="modal-error"]')));
    check('...and nothing was saved', (await pool.query('SELECT status FROM activities WHERE id=$1', [dupB])).rows[0].status === 'pending');
    await page.fill('#review-remarks', 'Please upload a sharper photo of the certificate.');
    await page.click('[data-testid="decision-correction"]');
    await page.waitForSelector('.toast');
    const d1 = (await pool.query('SELECT status, correction_notes, reviewer_id FROM activities WHERE id=$1', [dupB])).rows[0];
    check('correction request saved with notes and reviewer', d1.status === 'correction_requested' && /sharper photo/.test(d1.correction_notes) && d1.reviewer_id === fac.id, JSON.stringify(d1));
    const au = (await pool.query('SELECT old_status,new_status,version,reviewer_id FROM audit_log WHERE activity_id=$1 ORDER BY id DESC LIMIT 1', [dupB])).rows[0];
    check('audit entry written with version', au && au.old_status === 'pending' && au.new_status === 'correction_requested' && au.version === 1 && au.reviewer_id === fac.id, JSON.stringify(au));
    const note = (await pool.query(`SELECT title, link FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [s2.id])).rows[0];
    check('student was notified with a link', note && /Correction/.test(note.title) && note.link === `/activity/${dupB}`, JSON.stringify(note));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="review-modal"]').length === 0);
    check('tiles refreshed after the decision', (await statValue(page, 'correction_requested')) === 1 && (await statValue(page, 'pending')) === 15);
    check('decided item left the queue', (await page.locator(`[data-testid="row-${dupB}"]`).count()) === 0);

    // ---- previous review history is visible on a resubmitted item
    await page.click('[data-testid="reset-filters"]');
    await page.fill('input[aria-label="Search records"]', 'Corrected Internship');
    await page.waitForSelector(`[data-testid="review-${resub}"]`);
    await page.click(`[data-testid="review-${resub}"]`);
    await page.waitForSelector('[data-testid="review-history"] li');
    const hist = await page.textContent('[data-testid="review-history"]');
    check('earlier correction request and its reviewer are shown', /correction requested/.test(hist) && /company letterhead/.test(hist) && /v1/.test(hist) && /By E2E fac/.test(hist), hist);
    check('modal shows the current version (2)', /Version 2/.test(await page.textContent('[data-testid="review-modal"]')));

    // ---- a student resubmits while the reviewer has the old version open
    await pool.query(`UPDATE activities SET version = 3 WHERE id = $1`, [resub]);
    await page.click('[data-testid="decision-approve"]');
    await page.waitForSelector('[data-testid="modal-error"]');
    check('approval of a version the reviewer has not seen is refused', /resubmitted this activity after you opened it/.test(await page.textContent('[data-testid="modal-error"]')));
    check('...and the record is unchanged', (await pool.query('SELECT status FROM activities WHERE id=$1', [resub])).rows[0].status === 'resubmitted');
    await page.waitForFunction(() => /Version 3/.test(document.querySelector('[data-testid="review-modal"]')?.textContent || ''));
    check('modal reloaded to the latest version', true);
    await page.click('[data-testid="decision-approve"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="review-modal"]'));
    check('after reloading, approval of the new version succeeds', (await pool.query('SELECT status FROM activities WHERE id=$1', [resub])).rows[0].status === 'approved');
    const au2 = (await pool.query('SELECT version FROM audit_log WHERE activity_id=$1 ORDER BY id DESC LIMIT 1', [resub])).rows[0];
    check('approval audit entry carries version 3', au2.version === 3);

    // ---- a colleague decides first
    await page.click('[data-testid="reset-filters"]');
    await page.fill('input[aria-label="Search records"]', 'Queue Item 02');
    await page.waitForSelector(`[data-testid="review-${items[1]}"]`);
    await page.click(`[data-testid="review-${items[1]}"]`);
    await page.waitForSelector('[data-testid="decision-reject"]');
    const tok2 = await apiToken(fac2.email);
    const colleague = await fetch(`${API}/activities/${items[1]}/approve`, { method: 'PATCH', headers: { Authorization: `Bearer ${tok2}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_version: 1 }) });
    check('colleague approved it first', colleague.status === 200);
    await page.fill('#review-remarks', 'Not convincing');
    await page.click('[data-testid="decision-reject"]');
    await page.waitForSelector('[data-testid="modal-error"]');
    check('late rejection refused with a clear message', /already|cannot|Only/i.test(await page.textContent('[data-testid="modal-error"]')), await page.textContent('[data-testid="modal-error"]'));
    check('record stays approved (no double decision)', (await pool.query('SELECT status FROM activities WHERE id=$1', [items[1]])).rows[0].status === 'approved');
    await page.waitForSelector('[data-testid="already-decided"]');
    check('modal switches to the read-only "already decided" state', true);
    check('exactly one audit entry for that decision', (await pool.query(`SELECT COUNT(*)::int n FROM audit_log WHERE activity_id=$1 AND new_status IN ('approved','rejected')`, [items[1]])).rows[0].n === 1);
    await page.click('button[aria-label="Close"]');

    // ---- history tab
    await page.click('[data-testid="tab-history"]');
    await page.waitForSelector(`[data-testid="row-${approved}"]`); await page.waitForSelector(`[data-testid="row-${rejected}"]`);
    check('history lists decided records', (await page.locator(`[data-testid="row-${approved}"]`).count()) === 1 && (await page.locator(`[data-testid="row-${rejected}"]`).count()) === 1);
    check('history shows reviewer and remarks', /Illegible scan/.test(await page.textContent(`[data-testid="row-${rejected}"]`)) && /by E2E fac/.test(await page.textContent(`[data-testid="row-${rejected}"]`)));
    let hreq = page.waitForRequest((x) => x.url().includes('/activities/history') && x.url().includes('status=rejected'));
    await page.selectOption('select[aria-label="Status"]', 'rejected');
    await hreq;
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="row-"]').length === 1);
    check('history status filter -> only rejected', (await page.locator(`[data-testid="row-${rejected}"]`).count()) === 1 && (await page.locator(`[data-testid="row-${approved}"]`).count()) === 0);
    await page.click('[data-testid="reset-filters"]');
    hreq = page.waitForRequest((x) => x.url().includes('/activities/history') && x.url().includes('reviewed_by=me'));
    await page.check('input[aria-label="Reviewed by me"]');
    await hreq;
    await page.waitForTimeout(500);
    const mineRows = await page.locator('[data-testid^="row-"] h3').allTextContents(); // titles of the rows only
    check('"reviewed by me" hides colleague decisions', !mineRows.includes('Past Approved') && mineRows.includes('Past Rejected'), mineRows.join(','));
    await page.click('[data-testid="reset-filters"]');
    await page.screenshot({ path: path.join(out, '3-history.png') });

    // ---- audit trail page shows version tags
    await page.goto(`${WEB}/activity/${resub}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Verification Timeline');
    const tl = await page.textContent('body');
    check('audit timeline lists submission, correction, resubmission, approval with versions', /v1/.test(tl) && /v2/.test(tl) && /v3/.test(tl) && /letterhead/.test(tl));

    // ---- phone layout
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mob = await mctx.newPage();
    await signIn(mob, fac.email);
    await mob.waitForURL((u) => u.pathname === '/faculty');
    await mob.waitForSelector('[data-testid="filter-bar"]');
    await mob.waitForSelector('[data-testid^="row-"]');
    const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check('phone width: no horizontal scroll on the faculty page', !(await overflow(mob)));
    await mob.click('button[data-testid^="review-"]');
    await mob.waitForSelector('[data-testid="review-modal"] [data-testid="decision-approve"]');
    check('phone width: review modal does not overflow', !(await mob.evaluate(() => { const m = document.querySelector('[data-testid="review-modal"] > div'); return m.scrollWidth > m.clientWidth + 1; })));
    await mob.screenshot({ path: path.join(out, '4-mobile-modal.png') });

    // ---- a student cannot open the console
    const stuPage = await (await browser.newContext()).newPage();
    await signIn(stuPage, s1.email);
    await stuPage.waitForURL('**/dashboard');
    await stuPage.goto(`${WEB}/faculty`);
    await stuPage.waitForURL('**/dashboard');
    check('student is redirected away from the verification centre', true);
  } catch (e) {
    console.error('E2E ERROR', e.message.split('\n')[0]);
    try { for (const [i, pg] of browser.contexts().flatMap((c) => c.pages()).entries()) { await pg.screenshot({ path: path.join(out, `fail-${i}.png`) }); console.error('PAGE', i, pg.url(), (await pg.locator('[role="alert"], .toast').allTextContents()).join(' | ').slice(0, 300)); } } catch (_) { /* best effort */ }
    results.push({ name: 'script completed', ok: false });
  } finally {
    await browser.close();
    await pool.query('DELETE FROM activities WHERE student_id = ANY($1)', [userIds]);
    await pool.query('DELETE FROM notifications WHERE user_id = ANY($1)', [userIds]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    for (const f of files) fs.rmSync(f, { force: true });
    await pool.end();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
