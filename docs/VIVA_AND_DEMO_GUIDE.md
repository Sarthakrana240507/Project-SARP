# SARP — Demo Guide and Viva Preparation

## 1. One-minute explanation

> Colleges collect achievement proofs in chat groups and spreadsheets, and nobody can show who verified what. SARP gives every activity one record: the student uploads a proof, the server fingerprints it with SHA-256, a faculty member in the right scope approves, rejects or asks for a correction, and every decision lands in an append-only audit log. Approved activities become a downloadable verified portfolio. Administrators create the accounts from the college roster, so nobody signs up on their own.

## 2. Preparing the demo

Start from a clean database with demo data:

```bash
cd backend && npm run seed && npm start        # API :5001
cd frontend && npm run dev                      # web :3000
```

Local demo accounts come from `backend/scripts/seed.js`. If you prefer a clean install, create an administrator with `npm run admin:create` and build the data live as in section 3 (steps 1–3 *are* the setup). Keep two small files ready: a real-looking PDF "certificate" and a PNG.

Email is not configured in a demo, so activation links are copied from the admin console. Say so: "in production this link would be emailed; here I hand it over."

## 3. Demo script (about 12 minutes)

| # | Role | What to do | What to point out |
|---|---|---|---|
| 1 | — | Open `/login` | Three portals; no accounts or technical text on the screen. Try a student account in the **Faculty** portal: refused, and no session is created. The server checks the real role. |
| 2 | Admin | Administrator Access → sign in → **Student import** → upload a CSV with one good and one bad row → **Preview** | Preview creates nothing; the bad row is explained. Confirm. The student is *Invited* and has no password. |
| 3 | Admin | **Users** → search the student → **Activation link** | One-time link with the token after `#`. Copy it. |
| 4 | Student | Open the link, set a password, sign in at the Student Portal | The same link refuses a second use. |
| 5 | Admin | **Faculty** → **Add faculty** → create a reviewer → copy the activation link | Default scope = own department; the scope editor can widen it to all departments or empty it. |
| 6 | Student | **My activities** → fill the form, attach the PDF, **Submit for Verification** | Required fields, file-type check, status *Pending*. Save a second one as a draft to show drafts are private. |
| 7 | Faculty | Sign in at the Faculty Portal → queue → open the submission | SHA-256 digest, inline proof preview, history panel, duplicate warning (upload the *same* file again as another activity to show it). |
| 8 | Faculty | **Request correction** with no remarks (refused), then with remarks | Remarks are mandatory. |
| 9 | Student | Open the activity → read the instructions → **Resubmit with Corrections** with a new file | Version 2 created; version 1 and its proof remain visible. |
| 10 | Faculty | Review the resubmission → **Approve** | The review window shows the earlier decision. |
| 11 | Student | **Verified portfolio** → **Download Portfolio PDF** | Only approved activities appear. Open the PDF. |
| 12 | Admin | **Audit log** → filter; **Analytics & reports** → filters, **CSV** and **PDF** | The status journey is recorded in order; the log has no edit or delete controls. Every chart responds to filters. |
| 13 | Student | **Profile & settings** → upload a photo → choose **Dark** → **Contact & support** → send a ticket | Theme is saved to the account. Admin → **Support tickets** → mark *Resolved* with an internal note; the student sees the status but not the note. |

The same story is automated in `e2e/phase14.e2e.js` (workflows A–E, 46 checks, each backed by a database query) — run it if anything looks wrong before the viva.

## 4. Viva questions and honest answers

**Q1. Two reviewers open the same submission. What happens?**
Decisions run in a transaction with a row lock (`SELECT … FOR UPDATE`). The first commits; the second sees the record already decided and gets a clear message. There is also a version check: if the student resubmitted after a reviewer opened the old version, approving it is refused and the window reloads.

**Q2. What does the SHA-256 digest actually prove?**
That the stored file has not changed since upload and that the same bytes were not submitted twice. It does *not* prove the certificate is genuine (a forged certificate has a perfectly good digest), and a one-pixel edit produces a different digest. So a duplicate is a *warning for the reviewer*, not an automatic rejection.

**Q3. Why check magic bytes when Multer already filters by type?**
The extension and the declared MIME type come from the client and can be faked. The server reads the first bytes of the file and checks the real signature of PDF, PNG, JPEG or WEBP.

**Q4. Where are files stored and who can read them?**
On disk outside the web root, under random names; the database stores the path and metadata. Files are streamed only through authenticated endpoints that check ownership or verification scope. (Limitation: local disk means one server; production would use object storage.)

**Q5. If the login screen lets me pick "Faculty", can a student pretend to be faculty?**
No. The portal is only a hint sent with the login. The server loads the real role from the database and, if it differs, returns 403 and issues no token. Every later request re-reads the user from the database; roles in the token are never trusted.

**Q6. Why can't students register themselves?**
Anyone could claim any student ID. Accounts come from the administrator's roster. A student can *request* activation, but the details must match the roster, and the response never reveals whether an account exists. The activation link is single-use and expires; only its hash is stored.

**Q7. How is the audit log protected from tampering?**
Database triggers reject `UPDATE` and `DELETE` on `audit_log` and `admin_audit_log`, and the application has no edit path. Honest limit: someone with database superuser rights can still change anything; a stronger design would ship logs to write-once storage or chain hashes.

**Q8. How are passwords and sessions handled?**
bcrypt with 12 rounds; a password policy; JWT valid for 12 hours that is re-checked against the database on each request, so suspending an account takes effect immediately. Limitation: the token is kept in browser storage (an `httpOnly` cookie would resist script theft better), and login rate limits are in memory (single instance).

**Q9. How do you stop CSV exports from running formulas in Excel?**
Cells that begin with `=`, `+`, `-` or `@` are neutralised before export, and imported names that start that way are rejected.

**Q10. How are PDFs produced?**
PDFKit generates them on the server from database rows, streaming to the response; nothing is sent to an external service. Reports state the filters used.

**Q11. How do you know it works?**
136 backend tests plus a 16-scenario legacy suite, and browser tests that drive the real interface for each phase, including a contrast audit of 52 page states in both themes and the five workflows end to end with database checks. I also broke the code on purpose (mutation checks) — for example disabling the portal check — and confirmed the tests fail. What I could not test is listed in the final report (live email, screen readers, large data volumes).

**Q12. What would you do before real use?**
Rotate any secrets that were ever shared, move to httpOnly cookies, use a shared rate-limit store, put files on object storage with backups, run the database with least-privilege roles, add HTTPS and a reverse proxy, and pilot with a department. See the production checklist in the final report.

## 5. If something goes wrong during the demo

| Symptom | Likely cause | Fix |
|---|---|---|
| Login says too many attempts | In-memory rate limit | Restart the API |
| `ECONNREFUSED` on the API | PostgreSQL not running | Start it, restart the API |
| Support address missing | `NEXT_PUBLIC_SUPPORT_EMAIL` not set at build | Set it and rebuild the frontend |
| Student cannot sign in | Account still *Invited* | Copy an activation link from Users |
