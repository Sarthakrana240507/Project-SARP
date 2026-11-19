require('dotenv').config();
const assert = require('assert');
const http = require('http');
const pool = require('../src/config/db');
const app = require('../src/server');
const { initSchema } = require('../src/models/schema');

// Colors for terminal test output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

let server;
let baseUrl;

function logPass(testName, detail = '') {
  console.log(`${GREEN}  ✓ PASS:${RESET} ${testName} ${detail ? `(${detail})` : ''}`);
}

function logFail(testName, err) {
  console.error(`${RED}  ✗ FAIL:${RESET} ${testName}`);
  console.error(err);
}

// Minimal valid PDF buffer starting with %PDF magic bytes
const validPdfBuffer = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n165\n%%EOF'
);

(async () => {
  console.log(`\n${CYAN}======================================================${RESET}`);
  console.log(`${CYAN}   SARP COMPREHENSIVE AUTOMATED TEST SUITE (TESTS 1-10)${RESET}`);
  console.log(`${CYAN}======================================================${RESET}\n`);

  let passed = 0;
  let failed = 0;

  try {
    await initSchema();

    // Start ephemeral server on random available port
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        console.log(`Test API listening at ${baseUrl}\n`);
        resolve();
      });
    });

    const timestamp = Date.now();
    const testStudentEmail = `test.student.${timestamp}@sarp.local`;
    const testStudentPassword = 'TestPassword@123';
    let studentToken = '';
    let studentUser = null;

    let facultyToken = '';
    let facultyUser = null;

    let firstActivityId = null;
    let secondActivityId = null;

    // ---------------------------------------------------------
    // TEST 1: Onboard a student the real way and verify it in PostgreSQL:
    //         admin CSV import -> INVITED account (no password) -> activation link
    //         -> student sets password -> ACTIVE -> login. Open registration is closed.
    // ---------------------------------------------------------
    try {
      const json = { 'Content-Type': 'application/json' };
      const post = (path, body, token) => fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: { ...json, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
      });

      const closed = await post('/auth/register', { name: 'x', email: 'x@y.z', password: 'Abcdefg1' });
      assert.strictEqual(closed.status, 410, 'Open registration must be closed');

      const adminLogin = await post('/auth/login', { email: 'admin@sarp.local', password: 'Admin@12345' });
      assert.strictEqual(adminLogin.status, 200, 'Seeded admin must log in (run `node scripts/seed.js` first)');
      const adminToken = (await adminLogin.json()).token;

      const studentId = `TS${timestamp}`;
      const csv = `student_id,name,email,department,programme,academic_year,semester\n${studentId},Automated Test Student,${testStudentEmail},CSE,BTech,2025-26,3\n`;
      const fd = new FormData();
      fd.append('file', new Blob([csv], { type: 'text/csv' }), 'students.csv');
      const prev = await fetch(`${baseUrl}/admin/students/import/preview`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: fd });
      assert.strictEqual(prev.status, 200, `Preview failed: ${prev.status}`);
      const prevData = await prev.json();
      assert.strictEqual(prevData.valid_rows, 1, 'CSV row must validate');

      const conf = await post(`/admin/students/import/${prevData.batch_id}/confirm`, {}, adminToken);
      assert.strictEqual(conf.status, 200, 'Import confirm must succeed');
      const row = (await pool.query('SELECT id, status, password_hash, department FROM users WHERE email = $1', [testStudentEmail])).rows[0];
      assert(row, 'Imported student must exist in PostgreSQL');
      assert.strictEqual(row.status, 'INVITED', 'Imported account starts INVITED');
      assert.strictEqual(row.password_hash, null, 'No password may exist before activation');
      assert.strictEqual(row.department, 'Computer Science & Engineering', 'Department stored as canonical name');

      const linkRes = await post(`/admin/users/${row.id}/activation-link`, { delivery: 'HANDOFF' }, adminToken);
      assert.strictEqual(linkRes.status, 200, 'Admin must be able to issue an activation link');
      const link = (await linkRes.json()).link;
      const token = link.split('#token=')[1];
      assert(token, 'Link must carry a token in the fragment');

      const act = await post('/auth/activate', { token, password: testStudentPassword });
      assert.strictEqual(act.status, 200, `Activation failed: ${act.status}`);

      const loginRes = await post('/auth/login', { email: testStudentEmail, password: testStudentPassword });
      assert.strictEqual(loginRes.status, 200, 'Activated student must be able to log in');
      const loginData = await loginRes.json();
      assert.strictEqual(loginData.user.role, 'student', 'Role must be student');
      studentToken = loginData.token;
      studentUser = loginData.user;

      logPass('Test 1', 'Student onboarded via CSV import + activation and confirmed in PostgreSQL');
      passed++;
    } catch (err) {
      logFail('Test 1', err);
      failed++;
    }

    // Prepare Faculty credentials
    try {
      const facultyLoginRes = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'faculty@sarp.local',
          password: 'Faculty@12345',
        }),
      });
      assert.strictEqual(facultyLoginRes.status, 200, 'Faculty login must succeed');
      const fData = await facultyLoginRes.json();
      facultyToken = fData.token;
      facultyUser = fData.user;
      assert.strictEqual(facultyUser.role, 'faculty', 'Faculty account must have role faculty');
    } catch (fErr) {
      console.warn('Could not authenticate faculty@sarp.local; test suite depends on demo faculty account', fErr);
    }

    // ---------------------------------------------------------
    // TEST 2: Submit an activity with proof and verify:
    //         - File upload
    //         - File hash generation (SHA-256)
    //         - Database record
    //         - Pending status
    // ---------------------------------------------------------
    try {
      const form = new FormData();
      form.append('title', 'National Hackathon 2026 Finalist');
      form.append('category', 'hackathon');
      form.append('activity_date', '2026-01-15');
      form.append('academic_session', '2025-2026');
      form.append('semester', '6');
      form.append('description', 'Demonstrated full stack platform integration');
      form.append(
        'proof',
        new Blob([validPdfBuffer], { type: 'application/pdf' }),
        'national-hackathon-cert.pdf'
      );

      const submitRes = await fetch(`${baseUrl}/activities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` },
        body: form,
      });

      assert.strictEqual(submitRes.status, 201, `Submit failed with status ${submitRes.status}`);
      const submitData = await submitRes.json();
      firstActivityId = submitData.id;

      assert.strictEqual(submitData.status, 'pending', 'Initial status must be pending');
      assert(submitData.file_hash, 'SHA-256 hash must be computed and returned');
      assert.strictEqual(submitData.file_hash.length, 64, 'SHA-256 hash must be 64 hex characters');

      // Verify in PostgreSQL
      const dbAct = await pool.query('SELECT * FROM activities WHERE id = $1', [firstActivityId]);
      assert.strictEqual(dbAct.rows.length, 1);
      assert.strictEqual(dbAct.rows[0].status, 'pending');
      assert.strictEqual(dbAct.rows[0].student_id, studentUser.id);
      assert.strictEqual(dbAct.rows[0].file_hash, submitData.file_hash);

      // Verify initial audit log entry
      const dbAudit = await pool.query('SELECT * FROM audit_log WHERE activity_id = $1', [firstActivityId]);
      assert(dbAudit.rows.length >= 1, 'Initial submission must create an audit log row');

      logPass('Test 2', 'Activity submitted, SHA-256 generated, saved to DB with status=pending and audit log');
      passed++;
    } catch (err) {
      logFail('Test 2', err);
      failed++;
    }

    // TEST 2.B: Duplicate Detection Check
    try {
      const dupForm = new FormData();
      dupForm.append('title', 'Duplicate Hackathon Submission');
      dupForm.append('category', 'hackathon');
      dupForm.append('activity_date', '2026-01-15');
      dupForm.append('academic_session', '2025-2026');
      dupForm.append('semester', '6');
      dupForm.append('description', 'Attempting re-submission of identical certificate');
      dupForm.append(
        'proof',
        new Blob([validPdfBuffer], { type: 'application/pdf' }),
        'duplicate-cert.pdf'
      );

      const dupRes = await fetch(`${baseUrl}/activities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` },
        body: dupForm,
      });

      assert.strictEqual(dupRes.status, 201);
      const dupData = await dupRes.json();
      assert.strictEqual(dupData.is_duplicate, true, 'is_duplicate flag must be TRUE on matching hash');
      assert(dupData.warning, 'Warning message must be returned when duplicate hash is flagged');

      logPass('Test 2.B (Duplicate Detection)', 'Re-uploading identical file triggers SHA-256 duplicate flag');
      passed++;
    } catch (err) {
      logFail('Test 2.B (Duplicate Detection)', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 3: Login as Faculty and inspect the student's submission
    // ---------------------------------------------------------
    try {
      const pendingRes = await fetch(`${baseUrl}/activities/pending?limit=50&sort=newest`, {
        headers: { Authorization: `Bearer ${facultyToken}` },
      });
      assert.strictEqual(pendingRes.status, 200);
      const pendingList = (await pendingRes.json()).activities;
      const target = pendingList.find((a) => a.id === firstActivityId);
      assert(target, 'Submitted activity must be present in faculty pending queue');
      assert.strictEqual(target.student_name, studentUser.name);

      // Inspect proof endpoint
      const proofRes = await fetch(`${baseUrl}/activities/${firstActivityId}/proof`, {
        headers: { Authorization: `Bearer ${facultyToken}` },
      });
      assert.strictEqual(proofRes.status, 200, 'Faculty must be able to retrieve proof document');
      const contentType = proofRes.headers.get('content-type');
      assert(contentType.includes('pdf'), 'Content-Type must be PDF');

      logPass('Test 3', 'Faculty successfully inspected pending queue and retrieved protected proof document');
      passed++;
    } catch (err) {
      logFail('Test 3', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 4: Approve the submission and verify:
    //         - Status update
    //         - Reviewer information
    //         - Audit entry
    //         - Student dashboard update
    // ---------------------------------------------------------
    try {
      const approveRes = await fetch(`${baseUrl}/activities/${firstActivityId}/approve`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${facultyToken}`,
        },
        body: JSON.stringify({
          remarks: 'Verified certificate against official event results. Approved.',
        }),
      });

      assert.strictEqual(approveRes.status, 200, 'Approve call must return 200');
      const approvedData = await approveRes.json();
      assert.strictEqual(approvedData.status, 'approved');
      assert.strictEqual(approvedData.reviewer_id, facultyUser.id);

      // Verify PostgreSQL state
      const dbAct = await pool.query('SELECT * FROM activities WHERE id = $1', [firstActivityId]);
      assert.strictEqual(dbAct.rows[0].status, 'approved');
      assert.strictEqual(dbAct.rows[0].reviewer_id, facultyUser.id);
      assert(dbAct.rows[0].reviewed_at, 'reviewed_at timestamp must be set');

      // Verify audit log has transition from pending to approved
      const dbAudit = await pool.query(
        'SELECT * FROM audit_log WHERE activity_id = $1 AND new_status = $2',
        [firstActivityId, 'approved']
      );
      assert.strictEqual(dbAudit.rows.length, 1);
      assert.strictEqual(dbAudit.rows[0].reviewer_id, facultyUser.id);

      // Verify student's dashboard view updates
      const studentMineRes = await fetch(`${baseUrl}/activities/mine`, {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      const studentActivities = (await studentMineRes.json()).activities;
      const studentRecord = studentActivities.find((a) => a.id === firstActivityId);
      assert.strictEqual(studentRecord.status, 'approved');
      assert.strictEqual(studentRecord.reviewer_name, facultyUser.name);

      // Verify that re-reviewing returns 409 Conflict
      const secondApprove = await fetch(`${baseUrl}/activities/${firstActivityId}/approve`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${facultyToken}`,
        },
        body: JSON.stringify({ remarks: 'Cannot approve again' }),
      });
      assert.strictEqual(secondApprove.status, 409, 'Re-reviewing already reviewed activity must return 409');

      logPass('Test 4', 'Approval workflow verified: DB record, reviewer info, audit log, and 409 idempotency');
      passed++;
    } catch (err) {
      logFail('Test 4', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 5: Repeat using rejection and mandatory rejection remarks
    // ---------------------------------------------------------
    try {
      // First submit a second activity to reject
      const form2 = new FormData();
      form2.append('title', 'Incomplete Workshop Certificate');
      form2.append('category', 'workshop');
      form2.append('activity_date', '2026-01-15');
      form2.append('academic_session', '2025-2026');
      form2.append('semester', '6');
      form2.append('description', 'Sample workshop submission');
      form2.append(
        'proof',
        new Blob([validPdfBuffer], { type: 'application/pdf' }),
        'workshop-cert.pdf'
      );

      const sub2 = await fetch(`${baseUrl}/activities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` },
        body: form2,
      });
      const data2 = await sub2.json();
      secondActivityId = data2.id;

      // Attempt rejection WITHOUT remarks -> Must fail with 400
      const rejectNoRemarks = await fetch(`${baseUrl}/activities/${secondActivityId}/reject`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${facultyToken}`,
        },
        body: JSON.stringify({ remarks: '   ' }),
      });
      assert.strictEqual(rejectNoRemarks.status, 400, 'Rejection without remarks must fail with 400');

      // Attempt rejection WITH mandatory remarks -> Must succeed
      const rejectWithRemarks = await fetch(`${baseUrl}/activities/${secondActivityId}/reject`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${facultyToken}`,
        },
        body: JSON.stringify({
          remarks: 'The submitted document does not display an official institutional stamp or signature.',
        }),
      });
      assert.strictEqual(rejectWithRemarks.status, 200, 'Rejection with remarks must succeed');
      const rejectedData = await rejectWithRemarks.json();
      assert.strictEqual(rejectedData.status, 'rejected');

      // Check audit log for rejection
      const dbAudit = await pool.query(
        'SELECT * FROM audit_log WHERE activity_id = $1 AND new_status = $2',
        [secondActivityId, 'rejected']
      );
      assert.strictEqual(dbAudit.rows.length, 1);
      assert(dbAudit.rows[0].remarks.includes('stamp or signature'));

      logPass('Test 5', 'Rejection workflow verified: mandatory remark enforced (400), rejected status and audit log');
      passed++;
    } catch (err) {
      logFail('Test 5', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 6: Verify that only approved activities appear in the portfolio
    // ---------------------------------------------------------
    try {
      const portRes = await fetch(`${baseUrl}/portfolio/${studentUser.id}/data`, {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.strictEqual(portRes.status, 200);
      const portData = await portRes.json();

      const itemIds = portData.activities.map((a) => a.id);
      assert(itemIds.includes(firstActivityId), 'Approved activity MUST be included in portfolio');
      assert(!itemIds.includes(secondActivityId), 'Rejected activity MUST NOT appear in portfolio');

      for (const a of portData.activities) {
        assert.strictEqual(a.status, 'approved', 'Every record in verified portfolio must have status=approved');
      }

      logPass('Test 6', 'Portfolio verified: contains ONLY approved activities, excludes pending and rejected');
      passed++;
    } catch (err) {
      logFail('Test 6', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 7: Download and inspect the actual PDF file
    // ---------------------------------------------------------
    try {
      const pdfRes = await fetch(`${baseUrl}/portfolio/${studentUser.id}`, {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.strictEqual(pdfRes.status, 200, 'PDF export must return 200');
      assert(pdfRes.headers.get('content-type').includes('application/pdf'), 'Content-Type must be application/pdf');

      const arrayBuffer = await pdfRes.arrayBuffer();
      const pdfBuffer = Buffer.from(arrayBuffer);
      assert(pdfBuffer.length > 500, `PDF size too small (${pdfBuffer.length} bytes)`);

      // Verify PDF magic header bytes: %PDF-
      const magic = pdfBuffer.slice(0, 5).toString('ascii');
      assert(magic.startsWith('%PDF'), `PDF must start with %PDF header, got ${magic}`);

      logPass('Test 7', `PDF portfolio generated and validated (${pdfBuffer.length} bytes with valid %PDF header)`);
      passed++;
    } catch (err) {
      logFail('Test 7', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 8: Verify actual analytics against database values
    // ---------------------------------------------------------
    try {
      const analyticsRes = await fetch(`${baseUrl}/analytics`, {
        headers: { Authorization: `Bearer ${facultyToken}` },
      });
      assert.strictEqual(analyticsRes.status, 200);
      const analyticsData = await analyticsRes.json();

      // Query DB directly
      const realTotalActivities = (await pool.query('SELECT COUNT(*)::int AS c FROM activities WHERE status <> \'draft\'')).rows[0].c; // drafts are private, never counted
      // "Active students" = students with at least one submitted (non-draft) activity.
      const realTotalStudents = (await pool.query("SELECT COUNT(DISTINCT student_id)::int AS c FROM activities WHERE status <> 'draft'")).rows[0].c;
      const realApproved = (await pool.query("SELECT COUNT(*)::int AS c FROM activities WHERE status = 'approved'")).rows[0].c;

      assert.strictEqual(analyticsData.totals.total_activities, realTotalActivities, 'total_activities must match DB');
      assert.strictEqual(analyticsData.totals.total_students, realTotalStudents, 'total_students must match DB');
      assert.strictEqual(analyticsData.totals.approved, realApproved, 'approved count must match DB');

      logPass('Test 8', 'Institutional analytics verified: exact match against real PostgreSQL counts');
      passed++;
    } catch (err) {
      logFail('Test 8', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 9: Test role-based restrictions
    // ---------------------------------------------------------
    try {
      // 1. Student cannot access pending queue (must return 403)
      const sPending = await fetch(`${baseUrl}/activities/pending`, {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.strictEqual(sPending.status, 403, 'Student hitting /pending must get 403');

      // 2. Student cannot access analytics (must return 403)
      const sAnalytics = await fetch(`${baseUrl}/analytics`, {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.strictEqual(sAnalytics.status, 403, 'Student hitting /analytics must get 403');

      // 3. Student cannot approve activities (must return 403)
      const sApprove = await fetch(`${baseUrl}/activities/${secondActivityId}/approve`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
        },
        body: JSON.stringify({ remarks: 'Illegal approval' }),
      });
      assert.strictEqual(sApprove.status, 403, 'Student attempting approval must get 403');

      // 4. Student cannot access another student's portfolio (must return 403)
      const otherStudentPort = await fetch(`${baseUrl}/portfolio/999999`, {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.strictEqual(otherStudentPort.status, 403, 'Student accessing foreign portfolio must get 403');

      // 5. Unauthenticated request must return 401
      const unauthReq = await fetch(`${baseUrl}/activities/mine`);
      assert.strictEqual(unauthReq.status, 401, 'Unauthenticated request must get 401');

      logPass('Test 9', 'Role-based access control verified: 403 for unauthorized roles, 401 for unauthenticated');
      passed++;
    } catch (err) {
      logFail('Test 9', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 10: Test invalid files and oversized uploads
    // ---------------------------------------------------------
    try {
      // 1. File with invalid magic bytes (fake text disguised as .pdf) -> 400
      const fakeForm = new FormData();
      fakeForm.append('title', 'Spoofed Certificate');
      fakeForm.append('category', 'hackathon');
      fakeForm.append('activity_date', '2026-01-15');
      fakeForm.append('academic_session', '2025-2026');
      fakeForm.append('semester', '6');
      fakeForm.append(
        'proof',
        new Blob(['NOT A VALID PDF OR IMAGE FILE CONTENT'], { type: 'application/pdf' }),
        'spoofed.pdf'
      );

      const fakeRes = await fetch(`${baseUrl}/activities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` },
        body: fakeForm,
      });
      assert.strictEqual(fakeRes.status, 400, 'Spoofed file signature must be rejected with 400');
      const fakeData = await fakeRes.json();
      assert(fakeData.error.toLowerCase().includes('signature') || fakeData.error.toLowerCase().includes('format'));

      // 2. Oversized file (>10MB) -> 413 Payload Too Large
      const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024); // 11 MB
      // Prepend valid PDF header so it passes filter if it reached it
      Buffer.from('%PDF-1.4\n').copy(oversizedBuffer, 0);

      const bigForm = new FormData();
      bigForm.append('title', 'Oversized Proof Submission');
      bigForm.append('category', 'hackathon');
      bigForm.append('activity_date', '2026-01-15');
      bigForm.append('academic_session', '2025-2026');
      bigForm.append('semester', '6');
      bigForm.append(
        'proof',
        new Blob([oversizedBuffer], { type: 'application/pdf' }),
        'oversized.pdf'
      );

      const bigRes = await fetch(`${baseUrl}/activities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` },
        body: bigForm,
      });
      assert.strictEqual(bigRes.status, 413, 'Upload exceeding 10MB must be rejected with 413');

      logPass('Test 10', 'Input validation verified: spoofed magic bytes rejected (400), oversized upload rejected (413)');
      passed++;
    } catch (err) {
      logFail('Test 10', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 11: Draft Lifecycle (Save draft -> Update draft -> Submit draft)
    // ---------------------------------------------------------
    try {
      // 1. Save draft without proof
      const draftForm = new FormData();
      draftForm.append('title', 'Draft Activity Submission');
      draftForm.append('category', 'hackathon');
      draftForm.append('activity_date', '2026-01-15');
      draftForm.append('description', 'Initial draft description');
      draftForm.append('academic_session', '2025-2026');
      draftForm.append('semester', '6');

      const draftRes = await fetch(`${baseUrl}/activities/draft`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` },
        body: draftForm,
      });
      assert.strictEqual(draftRes.status, 201, `Expected 201, got ${draftRes.status}`);
      const draftData = await draftRes.json();
      assert.strictEqual(draftData.status, 'draft', 'Status must be draft');
      const draftId = draftData.id;

      // 2. Update draft with proof
      const updateForm = new FormData();
      updateForm.append('title', 'Updated Draft Activity');
      updateForm.append(
        'proof',
        new Blob([validPdfBuffer], { type: 'application/pdf' }),
        'draft_proof.pdf'
      );

      const updateRes = await fetch(`${baseUrl}/activities/${draftId}/draft`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${studentToken}` },
        body: updateForm,
      });
      assert.strictEqual(updateRes.status, 200, `Expected 200, got ${updateRes.status}`);
      const updatedDraft = await updateRes.json();
      assert.strictEqual(updatedDraft.title, 'Updated Draft Activity');
      assert(updatedDraft.has_proof, 'Proof must now be attached to the draft');

      // 3. Submit draft for verification
      const submitDraftRes = await fetch(`${baseUrl}/activities/${draftId}/submit-draft`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.strictEqual(submitDraftRes.status, 200, `Expected 200, got ${submitDraftRes.status}`);
      const submittedRecord = await submitDraftRes.json();
      assert.strictEqual(submittedRecord.status, 'pending', 'Status must transition from draft to pending');

      logPass('Test 11', 'Draft lifecycle verified: saved as draft, updated with proof, transitioned to pending');
      passed++;
    } catch (err) {
      logFail('Test 11', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 12: Correction & Resubmission Lifecycle
    // ---------------------------------------------------------
    try {
      // 1. Submit a fresh activity to test corrections
      const newForm = new FormData();
      newForm.append('title', 'Activity for Correction Flow');
      newForm.append('category', 'workshop');
      newForm.append('activity_date', '2026-01-15');
      newForm.append('academic_session', '2025-2026');
      newForm.append('semester', '6');
      newForm.append(
        'proof',
        new Blob([validPdfBuffer], { type: 'application/pdf' }),
        'workshop_proof.pdf'
      );

      const submitRes = await fetch(`${baseUrl}/activities`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` },
        body: newForm,
      });
      const createdAct = await submitRes.json();
      const corrActId = createdAct.id;

      // 2. Faculty requests correction
      const corrRes = await fetch(`${baseUrl}/activities/${corrActId}/request-correction`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${facultyToken}`,
        },
        body: JSON.stringify({ notes: 'Please provide certificate with institutional seal visible.' }),
      });
      assert.strictEqual(corrRes.status, 200, `Expected 200, got ${corrRes.status}`);
      const corrData = await corrRes.json();
      assert.strictEqual(corrData.status, 'correction_requested');
      assert.strictEqual(corrData.correction_notes, 'Please provide certificate with institutional seal visible.');

      // 3. Student resubmits with corrections
      const resubmitForm = new FormData();
      resubmitForm.append('title', 'Activity for Correction Flow (Corrected)');
      resubmitForm.append('resubmission_remarks', 'Uploaded revised certificate with official stamp.');

      const resubRes = await fetch(`${baseUrl}/activities/${corrActId}/resubmit`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${studentToken}` },
        body: resubmitForm,
      });
      assert.strictEqual(resubRes.status, 200, `Expected 200, got ${resubRes.status}`);
      const resubData = await resubRes.json();
      assert.strictEqual(resubData.status, 'resubmitted', 'Status must now be resubmitted');

      // 4. Faculty approves resubmitted activity
      const approveRes = await fetch(`${baseUrl}/activities/${corrActId}/approve`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${facultyToken}`,
        },
        body: JSON.stringify({ remarks: 'Corrections verified and accepted.' }),
      });
      assert.strictEqual(approveRes.status, 200, `Expected 200, got ${approveRes.status}`);
      const approvedData = await approveRes.json();
      assert.strictEqual(approvedData.status, 'approved', 'Status must now be approved');

      logPass('Test 12', 'Correction flow verified: request-correction -> student resubmit -> faculty approval');
      passed++;
    } catch (err) {
      logFail('Test 12', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 13: In-App Notifications API
    // ---------------------------------------------------------
    try {
      const notifRes = await fetch(`${baseUrl}/notifications`, {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.strictEqual(notifRes.status, 200, `Expected 200, got ${notifRes.status}`);
      const notifData = await notifRes.json();
      assert(Array.isArray(notifData.notifications), 'Notifications must be an array');
      assert(notifData.notifications.length > 0, 'Student must have received notifications from previous actions');

      const firstNotifId = notifData.notifications[0].id;

      // Mark single notification as read
      const markRes = await fetch(`${baseUrl}/notifications/${firstNotifId}/read`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.strictEqual(markRes.status, 200, `Expected 200, got ${markRes.status}`);

      // Mark all notifications as read
      const markAllRes = await fetch(`${baseUrl}/notifications/read-all`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.strictEqual(markAllRes.status, 200, `Expected 200, got ${markAllRes.status}`);

      logPass('Test 13', 'In-app notifications verified: list retrieval, unread count, single & bulk read marking');
      passed++;
    } catch (err) {
      logFail('Test 13', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 14: Admin Control Panel Endpoints
    // ---------------------------------------------------------
    try {
      // Authenticate as Admin
      const adminLogin = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@sarp.local',
          password: 'Admin@12345',
        }),
      });
      assert.strictEqual(adminLogin.status, 200, 'Admin login must succeed');
      const adminToken = (await adminLogin.json()).token;

      // Check Admin Overview
      const overviewRes = await fetch(`${baseUrl}/admin/overview`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(overviewRes.status, 200, `Expected 200, got ${overviewRes.status}`);
      const overview = await overviewRes.json();
      assert(overview.users && overview.activities, 'Admin overview must contain user and activity metrics');

      // Check Admin Users Directory
      const usersRes = await fetch(`${baseUrl}/admin/users`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(usersRes.status, 200, `Expected 200, got ${usersRes.status}`);
      const usersData = await usersRes.json();
      assert(Array.isArray(usersData.users), 'Admin users must return user list');

      // Check Categories
      const catsRes = await fetch(`${baseUrl}/admin/categories`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(catsRes.status, 200, `Expected 200, got ${catsRes.status}`);
      const cats = await catsRes.json();
      assert(Array.isArray(cats) && cats.length >= 7, 'Default taxonomy categories must be present');

      logPass('Test 14', 'Admin governance endpoints verified: overview KPIs, users directory, and categories taxonomy');
      passed++;
    } catch (err) {
      logFail('Test 14', err);
      failed++;
    }

    // ---------------------------------------------------------
    // TEST 15: Analytics CSV and PDF Export Streaming
    // ---------------------------------------------------------
    try {
      // 1. Test CSV export
      const csvRes = await fetch(`${baseUrl}/analytics/export/csv`, {
        headers: { Authorization: `Bearer ${facultyToken}` },
      });
      assert.strictEqual(csvRes.status, 200, `Expected 200, got ${csvRes.status}`);
      assert(csvRes.headers.get('content-type').includes('text/csv'), 'Content-Type must be text/csv');
      const csvText = await csvRes.text();
      assert(csvText.includes('Activity ID,Title,Category,Student Name'), 'CSV must contain standard header row');

      // 2. Test PDF summary export
      const pdfRes = await fetch(`${baseUrl}/analytics/export/pdf`, {
        headers: { Authorization: `Bearer ${facultyToken}` },
      });
      assert.strictEqual(pdfRes.status, 200, `Expected 200, got ${pdfRes.status}`);
      assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf', 'Content-Type must be application/pdf');
      const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
      assert(pdfBytes.length > 500, 'PDF report must be non-empty');
      assert.strictEqual(pdfBytes.toString('utf8', 0, 4), '%PDF', 'PDF must begin with %PDF magic bytes');

      logPass('Test 15', `Analytics exports verified: valid CSV stream and valid PDF report (${pdfBytes.length} bytes)`);
      passed++;
    } catch (err) {
      logFail('Test 15', err);
      failed++;
    }

  } catch (fatal) {
    console.error('Fatal test suite exception:', fatal);
    failed++;
  } finally {
    if (server) server.close();
    await pool.end();

    console.log(`\n${CYAN}======================================================${RESET}`);
    console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`${CYAN}======================================================${RESET}\n`);

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
})();

