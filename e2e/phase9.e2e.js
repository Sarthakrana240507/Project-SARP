// Phase 9 browser test: profile page, photo upload/replace/remove, navbar refresh, restricted fields, phone width.
// Needs PostgreSQL, backend on :5001, frontend (next start) on :3000.   node e2e/phase9.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const bcrypt = require('../backend/node_modules/bcryptjs');
const { Pool } = require('../backend/node_modules/pg');

const WEB = 'http://localhost:3000';
const PASSWORD = 'E2ePass@12345';
const tag = `e9${Date.now()}`;
const T = tag.toUpperCase().slice(-8);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const out = process.env.SHOTS || '/tmp/e2e-shots9';
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



const AV = path.resolve(__dirname, '../backend/uploads/avatars');
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'e2e9-'));
function makeImages() {
  // real, renderable images (PIL if present, otherwise tiny valid 1x1 files)
  const { spawnSync } = require('child_process');
  const py = `
from PIL import Image, ImageDraw
import sys
d=sys.argv[1]
for name,fmt,color in [('a.png','PNG',(62,111,176)),('b.jpg','JPEG',(49,153,143)),('c.webp','WEBP',(23,43,77))]:
    im=Image.new('RGB',(320,320),color); dr=ImageDraw.Draw(im); dr.ellipse((90,50,230,190),fill=(242,245,250)); dr.ellipse((50,200,270,420),fill=(242,245,250)); im.save(d+'/'+name,fmt)
`;
  const r = spawnSync('python3', ['-c', py, tmp]);
  if (r.status !== 0) {
    fs.writeFileSync(path.join(tmp, 'a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    fs.writeFileSync(path.join(tmp, 'b.jpg'), Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
    fs.writeFileSync(path.join(tmp, 'c.webp'), Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'));
  }
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'just text');
  fs.writeFileSync(path.join(tmp, 'huge.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5 * 1024 * 1024 + 10)]));
}
const kind = (page, id) => page.getAttribute(`[data-testid="${id}"]`, 'data-kind');
const photoFiles = () => new Set(fs.readdirSync(AV));
const row = async (id) => (await pool.query('SELECT profile_image_path p, name FROM users WHERE id=$1', [id])).rows[0];

(async () => {
  makeImages();
  const browser = await chromium.launch();
  const userIds = [];
  const before = photoFiles();
  try {
    const stu = await dbUser('student', 'stu', 'Computer Science & Engineering');
    const fac = await dbUser('faculty', 'fac', 'Computer Science & Engineering');
    const adm = await dbUser('admin', 'adm', null);
    userIds.push(stu.id, fac.id, adm.id);
    await pool.query(`UPDATE users SET employee_id=$2, designation='Associate Professor' WHERE id=$1`, [fac.id, `FAC${T}`]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await ctx.newPage();
    await signIn(page, stu.email); await page.waitForURL('**/dashboard');
    await page.waitForSelector('[data-testid="nav-avatar"]');
    check('navbar shows initials when there is no photo', (await kind(page, 'nav-avatar')) === 'initials');

    await page.goto(`${WEB}/profile`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="profile-avatar"]');
    const card = await page.textContent('main');
    check('profile shows email, role, department, student ID, programme, year, status',
      card.includes(stu.email) && /Student Account/i.test(card) && /BTech/.test(card) && card.includes('Computer Science & Engineering') && card.includes(`${tag}-stu`.toUpperCase()) && /2025-2026/.test(card) && /Active/.test(await page.textContent('[data-testid="profile-status"]')));
    check('profile avatar shows initials', (await kind(page, 'profile-avatar')) === 'initials');
    check('only the display name is editable (one text field in Edit Profile)', (await page.locator('form:has-text("Edit Profile") input').count()) === 1);

    // ---- client-side rejections
    await page.setInputFiles('[data-testid="photo-input"]', path.join(tmp, 'notes.txt'));
    await page.waitForSelector('[data-testid="photo-message"]');
    check('a text file is refused before upload', /JPG, JPEG, PNG or WEBP/.test(await page.textContent('[data-testid="photo-message"]')) && (await page.locator('[data-testid="photo-preview"]').count()) === 0);
    await page.setInputFiles('[data-testid="photo-input"]', path.join(tmp, 'huge.png'));
    await page.waitForFunction(() => /5 MB/.test(document.querySelector('[data-testid="photo-message"]')?.textContent || ''));
    check('a photo over 5 MB is refused before upload', (await page.locator('[data-testid="photo-preview"]').count()) === 0);

    // ---- preview, cancel, then save
    await page.setInputFiles('[data-testid="photo-input"]', path.join(tmp, 'a.png'));
    await page.waitForSelector('[data-testid="photo-preview"]');
    check('choosing a valid image shows a preview with Save and Cancel', (await page.locator('[data-testid="photo-save"]').count()) === 1 && (await page.locator('[data-testid="photo-cancel"]').count()) === 1);
    check('nothing has been uploaded yet', (await row(stu.id)).p === null);
    await page.click('[data-testid="photo-cancel"]');
    check('Cancel discards the preview', (await page.locator('[data-testid="photo-preview"]').count()) === 0 && (await row(stu.id)).p === null);
    await page.setInputFiles('[data-testid="photo-input"]', path.join(tmp, 'a.png'));
    await page.waitForSelector('[data-testid="photo-save"]');
    await page.click('[data-testid="photo-save"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="profile-avatar"]')?.getAttribute('data-kind') === 'photo');
    check('upload succeeds and the profile avatar becomes the photo', /uploaded/i.test(await page.textContent('[data-testid="photo-message"]')));
    check('navbar updates immediately, without a reload', (await kind(page, 'nav-avatar')) === 'photo');
    const file1 = (await row(stu.id)).p;
    check('only a file reference is stored, inside the avatar folder', !!file1 && file1.startsWith(AV) && fs.existsSync(file1));
    check('the button now says Replace and Remove is offered', /Replace photo/.test(await page.textContent('[data-testid="photo-choose"]')) && (await page.locator('[data-testid="photo-remove"]').count()) === 1);
    await page.screenshot({ path: path.join(out, '1-profile-photo.png') });

    // ---- persistence across reload and logout/login
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('[data-testid="profile-avatar"]')?.getAttribute('data-kind') === 'photo');
    check('photo is still there after a page reload', true);
    await page.click('[data-testid="nav-avatar-menu-button"]'); await page.click('[data-testid="menu-signout"]'); await page.waitForURL('**/login');
    await signIn(page, stu.email); await page.waitForURL('**/dashboard');
    await page.waitForFunction(() => document.querySelector('[data-testid="nav-avatar"]')?.getAttribute('data-kind') === 'photo');
    check('photo is still there after logout and login', true);

    // ---- another user never sees it
    const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const fp = await fctx.newPage();
    await signIn(fp, fac.email); await fp.waitForURL((u) => u.pathname === '/faculty'); await fp.waitForSelector('[data-testid="nav-avatar"]');
    check('faculty navbar shows their own initials, not the student\'s photo', (await kind(fp, 'nav-avatar')) === 'initials');

    // ---- replace
    await page.goto(`${WEB}/profile`, { waitUntil: 'networkidle' });
    await page.setInputFiles('[data-testid="photo-input"]', path.join(tmp, 'b.jpg'));
    await page.waitForSelector('[data-testid="photo-save"]'); await page.click('[data-testid="photo-save"]');
    await page.waitForFunction(() => /replaced/i.test(document.querySelector('[data-testid="photo-message"]')?.textContent || ''));
    const file2 = (await row(stu.id)).p;
    check('replace stores the new file and deletes the old one', file2 !== file1 && fs.existsSync(file2) && !fs.existsSync(file1));
    await page.setInputFiles('[data-testid="photo-input"]', path.join(tmp, 'c.webp'));
    await page.waitForSelector('[data-testid="photo-save"]'); await page.click('[data-testid="photo-save"]');
    await page.waitForFunction(() => /replaced/i.test(document.querySelector('[data-testid="photo-message"]')?.textContent || '') );
    await page.waitForTimeout(300);
    check('WEBP works too', /webp$/.test((await row(stu.id)).p));

    // ---- edit name: navbar follows at once
    const newName = `Asha Verma ${T}`;
    await page.fill('form:has-text("Edit Profile") input', newName);
    await page.click('button:has-text("Save Profile Changes")');
    await page.waitForFunction((n) => document.querySelector('[data-testid="profile-name"]')?.textContent === n, newName);
    check('renamed: profile heading updates', true);
    await page.click('[data-testid="nav-avatar-menu-button"]'); check('renamed: account menu shows the new name straight away', (await page.textContent('[data-testid="profile-menu"]')).includes(newName)); await page.keyboard.press('Escape');
    check('renamed: saved in the database and the photo is kept', (await row(stu.id)).name === newName && (await kind(page, 'nav-avatar')) === 'photo');

    // ---- remove
    const file3 = (await row(stu.id)).p;
    await page.click('[data-testid="photo-remove"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="profile-avatar"]')?.getAttribute('data-kind') === 'initials');
    check('Remove returns to the initials avatar (profile and navbar)', (await kind(page, 'nav-avatar')) === 'initials');
    check('removal clears the reference and deletes the file', (await row(stu.id)).p === null && !fs.existsSync(file3));
    check('initials come from the new name', (await page.textContent('[data-testid="nav-avatar"]')).trim() === `A${T[0]}`);

    // ---- faculty and admin have the same features
    await fp.goto(`${WEB}/profile`, { waitUntil: 'networkidle' });
    await fp.waitForSelector('[data-testid="photo-choose"]');
    const ftxt = await fp.textContent('main');
    check('faculty profile shows faculty ID, designation, department, scope and the upload control', ftxt.includes(`FAC${T}`) && ftxt.includes('Associate Professor') && /Verification scope/.test(ftxt) && /Faculty Account/i.test(ftxt));
    const actx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const ap = await actx.newPage();
    await signIn(ap, adm.email); await ap.waitForURL((u) => u.pathname === '/admin');
    await ap.goto(`${WEB}/profile`, { waitUntil: 'networkidle' });
    await ap.waitForSelector('[data-testid="photo-choose"]');
    await ap.setInputFiles('[data-testid="photo-input"]', path.join(tmp, 'b.jpg'));
    await ap.waitForSelector('[data-testid="photo-save"]'); await ap.click('[data-testid="photo-save"]');
    await ap.waitForFunction(() => document.querySelector('[data-testid="nav-avatar"]')?.getAttribute('data-kind') === 'photo');
    check('admin can upload a photo and sees Administrator access level', /Administrator|Super Admin/.test(await ap.textContent('main')));
    await ap.screenshot({ path: path.join(out, '2-admin-profile.png') });

    // ---- phone width
    const mctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const mp = await mctx.newPage();
    await signIn(mp, adm.email); await mp.waitForURL((u) => u.pathname === '/admin');
    await mp.goto(`${WEB}/profile`, { waitUntil: 'networkidle' });
    await mp.waitForSelector('[data-testid="profile-avatar"]');
    check('phone: navbar avatar is visible', await mp.locator('[data-testid="nav-avatar"]').isVisible());
    check('phone: profile page does not scroll sideways', !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    await mp.screenshot({ path: path.join(out, '3-mobile-profile.png') });

    // ---- signed-out visitors cannot reach photos
    const r = await fetch('http://localhost:5001/auth/profile/photo');
    check('the photo endpoint needs a signed-in user', r.status === 401);
  } catch (e) {
    console.error('E2E ERROR', e.message.split('\n')[0]);
    try { for (const [i, pg] of browser.contexts().flatMap((c) => c.pages()).entries()) { await pg.screenshot({ path: path.join(out, `fail-${i}.png`) }); console.error('PAGE', i, pg.url()); } } catch (_) { /* best effort */ }
    results.push({ name: 'script completed', ok: false });
  } finally {
    await browser.close();
    const q = (sql, p = []) => pool.query(sql, p).catch(() => {});
    for (const r of (await pool.query('SELECT profile_image_path p FROM users WHERE id = ANY($1)', [userIds]).catch(() => ({ rows: [] }))).rows) if (r.p) fs.rmSync(r.p, { force: true });
    await q('DELETE FROM notifications WHERE user_id = ANY($1)', [userIds]);
    await q('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    const leftovers = [...photoFiles()].filter((f) => !before.has(f));
    results.push({ name: 'no avatar files left behind', ok: leftovers.length === 0 }); console.log(`${leftovers.length === 0 ? 'PASS' : 'FAIL'}  no avatar files left behind ${leftovers.join(',')}`);
    await pool.end();
    fs.rmSync(tmp, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} E2E checks passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
