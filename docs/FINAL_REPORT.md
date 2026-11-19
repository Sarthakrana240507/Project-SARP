# SARP — Final Report

Honest status of the project after Phase 14. Everything marked PASS was run in this environment; everything marked BLOCKED could not be run here, and says why.

## 1. What was delivered

Starting point: the student-submitted SARP project (Next.js + Express + PostgreSQL). Work was done in 14 phases; the Phase 1–3 work (audit, security hardening, onboarding foundations) is the baseline commit `dbf5769`, and every later phase is its own commit.

### Implemented

| Area | Delivered |
|---|---|
| Accounts | Closed registration; admin-imported student roster (CSV preview → confirm); faculty and administrator creation; one-time activation links (hashed, expiring, single-use); verified self-activation request; forgot/reset password; Super Admin level; first-admin CLI |
| Sign-in | Role-selection screen (Student / Faculty / Administrator) with **server-side** role check (`403 PORTAL_MISMATCH`); clean login with no demo credentials, technical text or promotional footer |
| Student | Dashboard with real counts, activity form with drafts, proof upload (type + magic-byte check, 10 MB), My Activities with server-side filters and paging, correction requests and versioned resubmission, verified portfolio and PDF download |
| Faculty | Verification center limited to the assigned scope, filters and paging, review window (SHA-256 digest, duplicate warning, inline proof preview, history), approve / reject / request correction with mandatory remarks, stale-version and concurrent-decision protection, review history |
| Administrator | Overview, users, student import with history, faculty manager and scope editor, administrators panel, academic setup (departments, programmes, years, categories), support-ticket manager, read-only audit log |
| Platform | Analytics with real filters and 8 charts; CSV and PDF reports; in-app notifications; profile with photo; Light / Dark / System themes (saved per account); Contact & Support tickets; app shell with role-specific sidebar, top bar, account menu, and phone drawer; calm teal/blue palette |
| Integrity | Append-only `audit_log` and `admin_audit_log` (database triggers); SHA-256 digests; private file storage behind authenticated endpoints |

### Preserved

Original lifecycle, proof storage, SHA-256 duplicate detection, magic-byte validation, atomic review transactions, notifications, analytics and portfolio export all still work; the original 16-scenario test suite still passes. Database changes are additive only.

## 2. Changes in the continuation phases (13–14)

**Backend.** `POST /auth/login` accepts an optional `portal` (`student`, `faculty`, `admin`); non-string values return 400, a mismatch returns 403 `PORTAL_MISMATCH` with no token and no `last_login` update. No database change. New `backend/scripts/gen-reference.js` generates the API and schema references.

**Frontend.** New `components/shell/` (AppShell, NotificationBell, icons), `BrandMark`, `/login` chooser and `/login/[portal]`; the old top navbar and single login page were removed; every signed-in page is wrapped by the shell; admin sections are addressed as `/admin?tab=…`; new palette tokens in `styles/theme.css` for both themes; portfolio banner colours made theme-safe; student filter row no longer truncates.

**Database.** Phase 13–14: none. Whole project since baseline: migrations 004–010 (all additive).

**Tests added or changed.** `backend/test/portal.test.js` (4); `e2e/phase13.e2e.js` (55 checks); `e2e/phase14.e2e.js` (46 checks); all older e2e helpers now sign in through the matching portal.

**Documentation.** README, `docs/PROJECT_GUIDE.md`, `docs/DATABASE_AND_API_GUIDE.md`, generated `docs/reference/*`, `docs/VIVA_AND_DEMO_GUIDE.md`, diagrams in `docs/diagrams/`.

## 3. Test results

Run on the final code, with the backend restarted before each browser suite.

| Suite | Result |
|---|---|
| Backend `node:test` (analytics, support, portal, auth, onboarding, lifecycle, …) | **PASS** 136 / 136 |
| Legacy scenario suite (`scripts/test-suite.js`) | **PASS** 16 / 16 |
| Browser phase 4 – admin/faculty onboarding, scope | **PASS** 19 / 19 |
| Browser phase 5 – activity lifecycle | **PASS** 37 / 37 |
| Browser phase 6 – verification center | **PASS** 48 / 48 |
| Browser phase 7 – academic management, audit log | **PASS** 36 / 36 |
| Browser phase 8 – notifications | **PASS** 23 / 23 |
| Browser phase 9 – profile photo | **PASS** 30 / 30 |
| Browser phase 10 – themes + WCAG AA contrast audit (52 page states, 5,284 text elements) | **PASS** 37 / 37 |
| Browser phase 11 – support | **PASS** 37 / 37 |
| Browser phase 12 – analytics and reports | **PASS** 45 / 45 |
| Browser phase 13 – role login, portals, sidebars, drawer, palette | **PASS** 55 / 55 |
| Browser phase 14 – Workflows A–E | **PASS** 46 / 46 |
| `next build` (production) | **PASS** |
| `next lint` | **PASS**, 2 warnings (React hook dependency arrays in `pages/activity/[id].js` and `pages/admin.js`, present since the original code) |

### Workflows requested in the brief

| Workflow | Result | Verified in the database |
|---|---|---|
| **A** student submits with proof → faculty approves → student sees approval → portfolio PDF | PASS | status, version, SHA-256 digest recorded, reviewer, audit row, notification, PDF text contains the title, student and digest prefix; student cannot approve their own work (403) |
| **B** correction → resubmission → re-review → audit | PASS | two versions kept, status transitions in order, remarks required, audit rows cannot be altered |
| **C** admin imports students → activation → login | PASS | preview creates nothing; invalid row not imported; INVITED with no password → ACTIVE with a hashed password; INVITED cannot sign in; link not reusable; import in admin audit |
| **D** admin creates faculty → activation → login → queue | PASS | INVITED faculty, default scope = own department; refused at Student portal; reaches the queue with the right sidebar |
| **E** photo → theme → support ticket → admin manages | PASS | photo shown in top bar; theme saved on the account and kept after reload; ticket stored OPEN with the account email; admin status/notes saved; student sees status but the note is absent from page and API |

### Does the test suite catch mistakes?

Deliberate breakages were applied and the tests were confirmed to fail, then the code was restored: disabling the portal check (phase 13: 6 failures; phase 14: caught), leaking internal ticket notes to students (phase 14: caught), and, in earlier phases, mutations of theme, support and analytics behaviour. Several checks were found to be vacuous during this process (they passed regardless) and were strengthened.

### BLOCKED or not tested

| Item | Why |
|---|---|
| Live email delivery (SMTP) | No mail server available. The code path is unit-tested with a fake transport only. |
| Screen-reader and keyboard-only audit | No assistive technology here. Contrast was audited by script, not by a person. |
| Printing (print forces the light theme) | Not testable in headless automation. |
| Real browsers other than Chromium; real phones | Only headless Chromium at 390 px and 1280 px widths. |
| Load and large-data behaviour | Tested with hundreds of rows, not thousands of students. |
| Production deployment (HTTPS, reverse proxy, object storage) | Out of scope for this environment. |

### Known test fragility

The browser suites are timing-sensitive. During the final runs, several races in the test code (not the application) were found and fixed (for example waiting for a row to render before reading it). A fresh run can still occasionally fail on a slow machine; re-run the single suite before assuming an application bug.

## 4. Deviations from the brief

- **Secondary text colour.** The brief's `#75818A` on the page background is about 4:1, below the 4.5:1 WCAG AA minimum for normal text. Body-size secondary text uses `#5A6770`; the brief's colour is used only for decoration. Primary/secondary accent fills for white text were slightly darkened for the same reason; chart colours use the brief's hues.
- **Admin overview card.** The "Institutional Security & Verification Engine" panel on the admin overview still lists technical safeguards (SHA-256, magic bytes, row locks). It is informational, but a stricter reading of "no technical promotion" would remove it.
- **No decorative numbers.** Dashboard and admin figures are database counts; the admin overview's "Quick Governance Actions" are real links.

## 5. Known limitations and production checklist

**Limitations**

1. Login and other rate limits are held in server memory: they reset on restart and do not work across several instances.
2. The session token is stored in browser storage (readable by injected script). An `httpOnly` cookie would be stronger.
3. Uploaded files are on local disk: one server only, and they must be backed up with the database.
4. Audit immutability is enforced by database triggers; a database superuser can still alter the data.
5. Email is optional and unverified against a real server; without SMTP, an administrator must pass links on by hand.
6. A duplicate digest is a warning, not proof of fraud; the digest cannot show a certificate is genuine.
7. Single-institution design: no multi-tenancy, no single sign-on, no two-factor authentication, no account-lockout beyond rate limiting.
8. `activities.semester` is stored as text for compatibility with old data.
9. Two lint warnings remain (hook dependency arrays in `pages/activity/[id].js` and `pages/admin.js`).

**Before real use**

- Rotate every secret that has ever been shared or committed (database password, `JWT_SECRET`) — the original project contained a database URL and signing secret in its files; treat them as compromised.
- Set a strong `JWT_SECRET` (≥ 32 characters), `NODE_ENV=production`, `FRONTEND_URL`, and `NEXT_PUBLIC_SUPPORT_EMAIL` (a build-time setting).
- Back up the database (`pg_dump`) **before** running the migrations on existing data (009 and 010 add columns and a table).
- Run behind HTTPS and a reverse proxy; set `TRUST_PROXY=1`.
- Do not run `npm run seed` in production; create the first administrator with `npm run admin:create`.
- Decide on file storage and backups; consider a shared rate-limit store.

## 6. Exact startup instructions

Requirements: Node.js 18+ and PostgreSQL 14+.

```bash
# --- database ---
createdb sarp_dev

# --- backend ---
cd backend
npm install
cp .env.example .env
#   edit .env:  DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/sarp_dev
#               JWT_SECRET=<output of: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
npm run seed        # optional demo data (not for production)
npm start           # http://localhost:5001   (migrations run automatically)

# --- frontend (second terminal) ---
cd frontend
npm install
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:5001 ; optionally NEXT_PUBLIC_SUPPORT_EMAIL
npm run dev                        # http://localhost:3000
# production build instead:  npm run build && npm start

# --- clean install without demo data ---
cd backend && npm run admin:create -- --email you@college.edu --name "Your Name"   # prints a one-time activation link
```

Run the tests:

```bash
cd backend && npm test                  # 136 node:test + 16 legacy scenarios

# browser tests: Postgres + API :5001 + the frontend served on :3000 (use `next build && next start`)
cd e2e
export DATABASE_URL=...                 # same database as the API
node phase14.e2e.js                     # workflows A–E
node phase13.e2e.js                     # portals and shell
```

The browser suites create their own users and remove them afterwards. The API has a login rate limiter: restart it between suites that sign in many times.
