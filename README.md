# SARP — Student Activity Records Platform

SARP lets students record extracurricular and academic achievements with supporting proof, lets faculty verify them, and gives administrators the tools to run the whole process. Verified activities become an official, downloadable portfolio. Every decision is recorded in an append-only audit trail.

| Role | Signs in at | Can |
|---|---|---|
| Student | Student Portal | Submit activities with proof, save drafts, answer correction requests, follow verification, download a verified portfolio, manage profile, photo, theme, and raise support tickets |
| Faculty | Faculty Portal | Review the queue within their verification scope, inspect proof and its SHA-256 digest, approve, reject or request correction (with remarks), view analytics and reports |
| Administrator | Administrator Access | Import students, create faculty and administrators, hand out activation links, set verification scopes, manage departments, programmes, academic years and categories, handle support tickets, read the audit log |

The login screen lets a person choose a portal; the server then checks the account's real role from the database, so choosing the wrong portal never grants anything.

## Documentation

| Document | What it covers |
|---|---|
| [docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md) | Problem, solution, architecture, roles, authentication, onboarding, verification, document handling, SHA-256, audit, analytics, reporting |
| [docs/DATABASE_AND_API_GUIDE.md](docs/DATABASE_AND_API_GUIDE.md) | Data model (with ER diagram), migrations, API conventions |
| [docs/reference/api-routes.md](docs/reference/api-routes.md) | Every HTTP endpoint (generated from the code) |
| [docs/reference/database-schema.md](docs/reference/database-schema.md) | Every table, column, constraint and index (generated from the live database) |
| [docs/VIVA_AND_DEMO_GUIDE.md](docs/VIVA_AND_DEMO_GUIDE.md) | A timed demo script and viva questions with honest answers |
| [docs/FINAL_REPORT.md](docs/FINAL_REPORT.md) | What was built, what changed, what was tested (passed / failed / blocked), known limitations |

## Technology

Next.js 14 (pages router) + React 18 + Tailwind CSS + Recharts · Node.js + Express · PostgreSQL (`pg`) · JWT + bcryptjs (12 rounds) · Multer · PDFKit · nodemailer (optional).

## Run it locally

Requirements: Node.js 18+, PostgreSQL 14+.

```bash
# 1. database
createdb sarp_dev

# 2. backend
cd backend
npm install
cp .env.example .env          # set DATABASE_URL and a long random JWT_SECRET
npm run seed                  # OPTIONAL local demo data (refuses to run in production)
npm start                     # API on http://localhost:5001  (health: /health)

# 3. frontend (new terminal)
cd frontend
npm install
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:5001
npm run dev                        # http://localhost:3000
```

Migrations run automatically when the API starts. For a clean installation without demo data, create the first administrator instead of seeding:

```bash
cd backend
npm run admin:create -- --email you@college.edu --name "Your Name"   # prints a one-time activation link
```

Set `NEXT_PUBLIC_SUPPORT_EMAIL` in the frontend environment to show a support address on the sign-in and support pages (it is read at build time; without it the pages say no address is configured and point to the ticket form).

### Demo accounts (local demo data only)

`npm run seed` creates `student@sarp.local`, `faculty@sarp.local` and `admin@sarp.local` with passwords listed in `backend/scripts/seed.js`. They exist only for local demonstration and are never shown in the application. The seed script refuses to run when `NODE_ENV=production`.

### Email

Email is optional. With no `SMTP_HOST`, SARP sends nothing and says so: the administrator copies one-time activation or reset links from the admin console and passes them on. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` to enable delivery (not verified against a live mail server — see the final report).

## Tests

```bash
cd backend
npm test                        # legacy suite (16 scenarios) + node:test suites (136 tests)
node scripts/gen-reference.js   # regenerate docs/reference from code and database

# browser tests (need Postgres, the API on :5001 and `next start` on :3000)
cd ../e2e
node phase14.e2e.js             # the five end-to-end workflows A-E
node phase13.e2e.js             # role login, portals, sidebars
# phase4 ... phase12 cover onboarding, activities, review, admin, themes, support, analytics
```

See the [final report](docs/FINAL_REPORT.md) for the latest results and for what could not be tested.

## Known limitations (short list)

In-memory rate limiting (single instance only) · JWT kept in browser storage · uploads on local disk · no live-SMTP verification · no screen-reader testing · see the final report for the full list and the production checklist.
