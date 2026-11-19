const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { scopeFragment, canAccessStudent } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { logAdminAudit } = require('../utils/adminAudit');
const { createNotification, notifyScopedFaculty } = require('../utils/notifications');
const { transitionProblem, STATUSES } = require('../utils/lifecycle');
const { validateActivityFields, problemText, likePattern, LIMITS, validCalendarDate } = require('../utils/activityInput');
const { MAX_PROOF_MB, uploadProof, trackUpload, removeFile, inspectProof } = require('../utils/proofFiles');
const { toClient, toClientList } = require('../utils/activityView');
const { normalizeAcademicYear } = require('../utils/validation');
const { listForReviewer, reviewSummary, QueryError } = require('../utils/reviewQueue');

const router = express.Router();

const UNTITLED = 'Untitled draft';
const FIELD_KEYS = ['title', 'category', 'description', 'activity_date', 'academic_session', 'semester'];
// requireRole runs before the upload so a non-student can never even put a file on disk.
const studentUpload = [requireAuth, requireRole('student'), trackUpload, uploadProof];

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Students: only their own records. Faculty: only students inside their verification scope.
// Admin: everything. (See utils/scope.js)
async function canView(req, studentId) {
  return canAccessStudent(pool, req.user, studentId);
}

// ---------------------------------------------------------------- small helpers
class HttpError extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const fail = (status, error, extra = {}) => new HttpError(status, { error, ...extra });
const invalid = (errors) => new HttpError(400, { error: problemText(errors), fields: errors });

// Runs fn inside BEGIN/COMMIT; any throw rolls everything back (rows, audit entries, notifications together).
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

// Locks the row for the rest of the transaction. Someone else's activity looks exactly like a missing one.
async function lockOwned(client, id, studentId) {
  const r = await client.query(
    `SELECT * FROM activities WHERE id = $1 AND student_id = $2 FOR UPDATE`,
    [id, studentId]
  );
  if (!r.rows[0]) throw fail(404, 'Activity not found');
  return r.rows[0];
}

// A field present in the request replaces the stored value; an absent one keeps it.
function mergeFields(body, existing) {
  const out = {};
  for (const k of FIELD_KEYS) {
    const incoming = k === 'academic_session' ? (body.academic_session ?? body.academicSession ?? body.academic_year) : body[k];
    out[k] = incoming !== undefined ? incoming : existing?.[k];
  }
  if (out.title === UNTITLED) out.title = '';
  return out;
}

const safeName = (n) => path.basename(String(n || 'proof')).replace(/[\u0000-\u001F"\\]/g, '_').slice(0, 200) || 'proof';

// Reads the uploaded file (if any) and checks its real content. Returns null when nothing was uploaded.
async function readUploadedProof(req) {
  if (!req.file) return null;
  const insp = await inspectProof(req.file);
  if (!insp.ok) throw fail(400, insp.error, { fields: { proof: insp.error } });
  return { path: req.file.path, original: safeName(req.file.originalname), mime: insp.mime, size: req.file.size, hash: insp.hash };
}
const currentProof = (a) => (a.proof_file_path
  ? { path: a.proof_file_path, original: a.proof_original_name, mime: a.proof_mime_type, size: a.proof_size, hash: a.file_hash }
  : null);

// The earliest OTHER activity that was ever submitted with the same file. Flagged for a human to look at; never an automatic verdict.
async function findDuplicate(db, hash, activityId) {
  const r = await db.query(
    `SELECT activity_id FROM activity_versions WHERE file_hash = $1 AND activity_id <> $2 ORDER BY created_at, id LIMIT 1`,
    [hash, activityId || 0]
  );
  return r.rows[0]?.activity_id || null;
}

// One row per submission so earlier evidence and details are never lost.
async function recordVersion(client, a, note) {
  await client.query(
    `INSERT INTO activity_versions (activity_id, version, title, category, description, activity_date, academic_session, semester,
        proof_file_path, proof_original_name, proof_mime_type, proof_size, file_hash, is_duplicate, duplicate_of, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [a.id, a.version, a.title, a.category, a.description, a.activity_date, a.academic_session, a.semester,
      a.proof_file_path, a.proof_original_name, a.proof_mime_type, a.proof_size, a.file_hash, a.is_duplicate, a.duplicate_of, note || null]
  );
}

const ACTIVITY_COLUMNS = `title, category, description, activity_date, academic_session, semester,
  proof_file_path, proof_original_name, proof_mime_type, proof_size, file_hash`;
const fieldParams = (v, p) => [v.title, v.category, v.description, v.activity_date, v.academic_session, v.semester,
  p?.path || null, p?.original || null, p?.mime || null, p?.size || null, p?.hash || null];
const DUP_WARNING = 'This proof file matches an earlier submission and has been flagged for faculty to look at. It is not treated as fraud.';

// ---------------------------------------------------------------- form options
/** GET /activities/options - everything the submission form needs, from the database (no hard-coded lists). */
router.get('/options', requireAuth, handle(async (_req, res) => {
  const cats = await pool.query('SELECT name, display_name FROM categories WHERE is_active = TRUE ORDER BY display_name');
  const sess = await pool.query('SELECT name, current_semester, is_current, is_archived FROM academic_sessions ORDER BY name DESC');
  const now = new Date();
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; // academic years start in July
  const computed = Array.from({ length: 5 }, (_, i) => `${startYear - i}-${startYear - i + 1}`);
  const fromTable = sess.rows.map((s) => normalizeAcademicYear(s.name)).filter(Boolean);
  const years = [...new Set([...fromTable, ...computed])].sort().reverse();
  const archived = new Set(sess.rows.filter((s) => s.is_archived).map((s) => normalizeAcademicYear(s.name)));
  const current = sess.rows.find((s) => s.is_current);
  const semOf = (v) => { const m = /(\d+)/.exec(String(v ?? '')); return m ? Number(m[1]) : null; }; // accepts "5" and the older "Semester 5"
  res.json({
    categories: cats.rows,
    academic_years: years, // every year on record (for filters)
    open_academic_years: years.filter((y) => !archived.has(y)), // years that still take new submissions
    current_academic_year: (current && normalizeAcademicYear(current.name)) || computed[0],
    current_semester: current ? semOf(current.current_semester) : null,
    semesters: Array.from({ length: 10 }, (_, i) => i + 1),
    limits: { max_proof_mb: MAX_PROOF_MB, allowed_types: ['PDF', 'PNG', 'JPG', 'JPEG', 'WEBP'], title_min: LIMITS.titleMin, title_max: LIMITS.titleMax, description_max: LIMITS.descriptionMax },
  });
}));

// ---------------------------------------------------------------- create
/** POST /activities - submit a new activity straight for review (proof required). */
router.post('/', ...studentUpload, handle(async (req, res) => {
  const { errors, value } = await validateActivityFields(pool, mergeFields(req.body, null), { strict: true });
  const proof = await readUploadedProof(req);
  if (!proof) errors.proof = 'Attach a proof document (PDF, PNG, JPG or WEBP).';
  if (Object.keys(errors).length) throw invalid(errors);

  const { row, duplicate } = await inTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO activities (student_id, ${ACTIVITY_COLUMNS}, status, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',1) RETURNING *`,
      [req.user.id, ...fieldParams(value, proof)]
    );
    let a = ins.rows[0];
    const dupOf = await findDuplicate(client, proof.hash, a.id);
    if (dupOf) a = (await client.query('UPDATE activities SET is_duplicate = TRUE, duplicate_of = $2 WHERE id = $1 RETURNING *', [a.id, dupOf])).rows[0];
    await recordVersion(client, a, null);
    await logAudit(client, {
      activityId: a.id, studentId: req.user.id, reviewerId: null, oldStatus: 'none', newStatus: 'pending', version: 1,
      remarks: dupOf ? 'Submitted for verification (flagged: proof file matches an earlier submission)' : 'Submitted for verification',
    });
    await createNotification(client, {
      userId: req.user.id, title: 'Activity Submitted',
      message: `Your activity "${a.title}" has been submitted for faculty verification.`, type: 'info', link: `/activity/${a.id}`,
    });
    await notifyScopedFaculty(client, req.user.id, {
      title: 'New Activity to Review', message: `A student submitted "${a.title}" for verification.`, type: 'info', link: `/activity/${a.id}`,
    });
    return { row: a, duplicate: Boolean(dupOf) };
  });
  req.proofKept = true;
  res.status(201).json({ ...toClient(row, 'student'), warning: duplicate ? DUP_WARNING : undefined });
}));

/** POST /activities/draft - save an incomplete activity. Everything is optional, but what is filled in must be valid. */
router.post('/draft', ...studentUpload, handle(async (req, res) => {
  const { errors, value } = await validateActivityFields(pool, mergeFields(req.body, null), { strict: false });
  if (Object.keys(errors).length) throw invalid(errors);
  const proof = await readUploadedProof(req);

  const row = await inTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO activities (student_id, ${ACTIVITY_COLUMNS}, status, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',1) RETURNING *`,
      [req.user.id, ...fieldParams({ ...value, title: value.title || UNTITLED }, proof)]
    );
    await logAudit(client, { activityId: ins.rows[0].id, studentId: req.user.id, reviewerId: null, oldStatus: 'none', newStatus: 'draft', remarks: 'Saved as draft' });
    return ins.rows[0];
  });
  req.proofKept = true;
  res.status(201).json(toClient(row, 'student'));
}));

// ---------------------------------------------------------------- edit / discard a draft
/** PUT /activities/:id/draft - change a draft. Only drafts can be edited; submitted activities change through resubmission. */
router.put('/:id/draft', ...studentUpload, handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid activity id');

  const { row, replacedPath } = await inTransaction(async (client) => {
    const ex = await lockOwned(client, id, req.user.id);
    if (ex.status !== 'draft') throw fail(409, 'Only drafts can be edited. A submitted activity can be changed only when a reviewer asks for corrections.');
    const { errors, value } = await validateActivityFields(client, mergeFields(req.body, ex), { strict: false, existingYear: ex.academic_session });
    if (Object.keys(errors).length) throw invalid(errors);
    const uploaded = await readUploadedProof(req);
    const proof = uploaded || currentProof(ex);
    const u = await client.query(
      `UPDATE activities SET title=$2, category=$3, description=$4, activity_date=$5, academic_session=$6, semester=$7,
         proof_file_path=$8, proof_original_name=$9, proof_mime_type=$10, proof_size=$11, file_hash=$12
       WHERE id = $1 RETURNING *`,
      [id, ...fieldParams({ ...value, title: value.title || UNTITLED }, proof)]
    );
    return { row: u.rows[0], replacedPath: uploaded ? ex.proof_file_path : null };
  });
  if (req.file) req.proofKept = true;
  removeFile(replacedPath); // a draft's old proof was never submitted, so nothing refers to it
  res.json(toClient(row, 'student'));
}));

/** DELETE /activities/:id - discard a draft (and its file). Submitted activities are never deleted. */
router.delete('/:id', requireAuth, requireRole('student'), handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid activity id');
  const path_ = await inTransaction(async (client) => {
    const ex = await lockOwned(client, id, req.user.id);
    if (ex.status !== 'draft') throw fail(409, 'Only drafts can be discarded. Submitted activities are part of your verification record.');
    await client.query('DELETE FROM activities WHERE id = $1', [id]);
    return ex.proof_file_path;
  });
  removeFile(path_);
  res.json({ success: true });
}));

// ---------------------------------------------------------------- submit a draft
/** POST /activities/:id/submit-draft - send a draft for review. Details and proof may be completed in the same request. */
router.post('/:id/submit-draft', ...studentUpload, handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid activity id');

  const { row, replacedPath, duplicate } = await inTransaction(async (client) => {
    const ex = await lockOwned(client, id, req.user.id); // two quick clicks: the second waits here, then sees "pending"
    const problem = transitionProblem(ex.status, 'pending', 'student');
    if (problem) throw fail(409, ex.status === 'draft' ? problem : `This activity is already ${ex.status.replace(/_/g, ' ')}.`);

    const { errors, value } = await validateActivityFields(client, mergeFields(req.body, ex), { strict: true, existingYear: ex.academic_session });
    const uploaded = await readUploadedProof(req);
    const proof = uploaded || currentProof(ex);
    if (!proof) errors.proof = 'Attach a proof document before submitting.';
    else if (!uploaded && !fs.existsSync(proof.path)) errors.proof = 'The saved proof file is missing. Upload it again.';
    if (Object.keys(errors).length) throw invalid(errors);

    const dupOf = await findDuplicate(client, proof.hash, id);
    const u = await client.query(
      `UPDATE activities SET title=$2, category=$3, description=$4, activity_date=$5, academic_session=$6, semester=$7,
         proof_file_path=$8, proof_original_name=$9, proof_mime_type=$10, proof_size=$11, file_hash=$12,
         status='pending', version=1, is_duplicate=$13, duplicate_of=$14
       WHERE id = $1 RETURNING *`,
      [id, ...fieldParams(value, proof), Boolean(dupOf), dupOf]
    );
    const a = u.rows[0];
    await recordVersion(client, a, null);
    await logAudit(client, {
      activityId: id, studentId: req.user.id, reviewerId: null, oldStatus: 'draft', newStatus: 'pending', version: 1,
      remarks: dupOf ? 'Draft submitted (flagged: proof file matches an earlier submission)' : 'Draft submitted for verification',
    });
    await createNotification(client, {
      userId: req.user.id, title: 'Activity Submitted',
      message: `Your draft "${a.title}" was submitted for faculty verification.`, type: 'info', link: `/activity/${id}`,
    });
    await notifyScopedFaculty(client, req.user.id, {
      title: 'New Activity to Review', message: `A student submitted "${a.title}" for verification.`, type: 'info', link: `/activity/${id}`,
    });
    return { row: a, replacedPath: uploaded ? ex.proof_file_path : null, duplicate: Boolean(dupOf) };
  });
  if (req.file) req.proofKept = true;
  removeFile(replacedPath);
  res.json({ ...toClient(row, 'student'), warning: duplicate ? DUP_WARNING : undefined });
}));

// ---------------------------------------------------------------- resubmit after corrections
/**
 * PUT /activities/:id/resubmit - answer a correction request. Creates a NEW version; the earlier version,
 * its proof file and every earlier review entry stay exactly as they were.
 */
router.put('/:id/resubmit', ...studentUpload, handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid activity id');
  const remarks = String(req.body.remarks ?? req.body.resubmission_remarks ?? '').replace(/\r\n/g, '\n').trim();

  const { row, duplicate } = await inTransaction(async (client) => {
    const ex = await lockOwned(client, id, req.user.id);
    const problem = transitionProblem(ex.status, 'resubmitted', 'student');
    if (problem) throw fail(409, ex.status === 'correction_requested' ? problem : `Only an activity with a correction request can be resubmitted (this one is ${ex.status.replace(/_/g, ' ')}).`);

    const { errors, value } = await validateActivityFields(client, mergeFields(req.body, ex), { strict: true, existingYear: ex.academic_session });
    if (remarks.length > LIMITS.remarksMax) errors.remarks = `Your note must be at most ${LIMITS.remarksMax} characters.`;
    const uploaded = await readUploadedProof(req);
    const proof = uploaded || currentProof(ex);
    if (!proof) errors.proof = 'Attach a proof document.';
    else if (!uploaded && !fs.existsSync(proof.path)) errors.proof = 'The previous proof file is missing. Upload it again.';
    if (Object.keys(errors).length) throw invalid(errors);

    const changed = Boolean(uploaded) || FIELD_KEYS.some((k) => String(value[k] ?? '') !== String(ex[k] ?? ''));
    if (!changed && !remarks) throw fail(400, 'Change the details or evidence, or write a short note explaining what you corrected.', { fields: { remarks: 'Add a note for the reviewer.' } });

    const dupOf = await findDuplicate(client, proof.hash, id);
    const version = ex.version + 1;
    const u = await client.query(
      `UPDATE activities SET title=$2, category=$3, description=$4, activity_date=$5, academic_session=$6, semester=$7,
         proof_file_path=$8, proof_original_name=$9, proof_mime_type=$10, proof_size=$11, file_hash=$12,
         status='resubmitted', version=$13, is_duplicate=$14, duplicate_of=$15, resubmitted_at=NOW()
       WHERE id = $1 RETURNING *`,
      [id, ...fieldParams(value, proof), version, Boolean(dupOf), dupOf]
    );
    const a = u.rows[0];
    await recordVersion(client, a, remarks);
    await logAudit(client, {
      activityId: id, studentId: req.user.id, reviewerId: null, oldStatus: 'correction_requested', newStatus: 'resubmitted',
      remarks: remarks || 'Resubmitted with corrections', version,
    });
    await createNotification(client, {
      userId: req.user.id, title: 'Activity Resubmitted',
      message: `Your activity "${a.title}" was resubmitted for faculty re-verification.`, type: 'info', link: `/activity/${id}`,
    });
    // The previous reviewer (even if their scope changed since) and everyone whose scope covers this student.
    await notifyScopedFaculty(client, req.user.id, {
      title: 'Activity Resubmitted', message: `A student resubmitted corrections for "${a.title}".`, type: 'info', link: `/activity/${id}`,
    }, [ex.reviewer_id]);
    return { row: a, duplicate: Boolean(dupOf) };
  });
  if (req.file) req.proofKept = true; // the previous version's file is deliberately NOT deleted
  res.json({ ...toClient(row, 'student'), warning: duplicate ? DUP_WARNING : undefined });
}));

// ---------------------------------------------------------------- the student's own list
const SORTS = {
  newest: 'activities.created_at DESC, activities.id DESC',
  oldest: 'activities.created_at ASC, activities.id ASC',
  date_newest: 'COALESCE(activities.activity_date, activities.created_at::date) DESC, activities.id DESC',
  date_oldest: 'COALESCE(activities.activity_date, activities.created_at::date) ASC, activities.id ASC',
};

/**
 * GET /activities/mine?search=&status=&category=&academic_session=&semester=&date_from=&date_to=&sort=&page=&limit=
 * Every filter is applied by the database. "status=pending" means waiting for review (pending + resubmitted).
 */
router.get('/mine', requireAuth, requireRole('student'), handle(async (req, res) => {
  const q = req.query;
  const where = ['activities.student_id = $1'];
  const params = [req.user.id];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

  const status = String(q.status || 'all');
  if (status === 'pending') where.push(`activities.status IN ('pending', 'resubmitted')`);
  else if (status !== 'all') {
    if (!STATUSES.includes(status)) throw fail(400, 'Unknown status filter');
    add('activities.status = ?', status);
  }
  if (q.category && q.category !== 'all') add('activities.category = ?', String(q.category).toLowerCase());
  if (q.academic_session && q.academic_session !== 'all') {
    const y = normalizeAcademicYear(q.academic_session);
    if (!y) throw fail(400, 'Academic year must look like 2025-2026');
    add('activities.academic_session = ?', y);
  }
  if (q.semester && q.semester !== 'all') {
    if (!/^\d{1,2}$/.test(String(q.semester))) throw fail(400, 'Semester must be a number');
    add('activities.semester = ?', String(Number(q.semester)));
  }
  for (const [key, op] of [['date_from', '>='], ['date_to', '<=']]) {
    if (!q[key]) continue;
    if (!validCalendarDate(String(q[key]))) throw fail(400, `${key} must be a date like 2026-01-31`);
    add(`COALESCE(activities.activity_date, activities.created_at::date) ${op} ?::date`, String(q[key]));
  }
  if (q.date_from && q.date_to && String(q.date_from) > String(q.date_to)) throw fail(400, 'The start date is after the end date');
  if (q.search && String(q.search).trim()) {
    params.push(likePattern(q.search));
    where.push(`(activities.title ILIKE $${params.length} OR COALESCE(activities.description, '') ILIKE $${params.length})`);
  }
  const sort = SORTS[q.sort] || SORTS.newest;
  if (q.sort && !SORTS[q.sort]) throw fail(400, 'Unknown sort order');
  const limit = Math.min(50, Math.max(1, parseInt(q.limit, 10) || 10));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const whereSql = where.join(' AND ');

  const [total, rows, counts] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM activities WHERE ${whereSql}`, params),
    pool.query(
      `SELECT activities.*, reviewer.name AS reviewer_name
       FROM activities LEFT JOIN users reviewer ON reviewer.id = activities.reviewer_id
       WHERE ${whereSql} ORDER BY ${sort} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
    // Overall numbers for the dashboard tiles: independent of the filters above.
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'draft')::int AS draft,
              COUNT(*) FILTER (WHERE status IN ('pending','resubmitted'))::int AS pending,
              COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
              COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              COUNT(*) FILTER (WHERE status = 'correction_requested')::int AS correction_requested
       FROM activities WHERE student_id = $1`, [req.user.id]),
  ]);
  res.json({
    activities: toClientList(rows.rows, 'student'),
    total: total.rows[0].n, page, limit, pages: Math.max(1, Math.ceil(total.rows[0].n / limit)),
    counts: counts.rows[0],
  });
}));

/**
 * Reviewer lists. Same filters for both; everything is applied by the database and limited to the reviewer's scope.
 *   GET /activities/pending  - waiting for a decision (pending + resubmitted)
 *   GET /activities/history  - already decided (approved / rejected / correction_requested)
 * Query: search, status, department, category, academic_session, semester, date_from, date_to (submission date),
 *        duplicate=true, sort, page, limit (history also: reviewed_by=me)
 * Response: { activities, total, page, limit, pages }
 */
const reviewerList = (mode) => handle(async (req, res) => {
  let result;
  try {
    result = await listForReviewer(req.user, req.query, mode);
  } catch (err) {
    if (err instanceof QueryError) throw fail(400, err.message);
    throw err;
  }
  const { rows, ...paging } = result;
  res.json({ activities: toClientList(rows, req.user.role), ...paging });
});
router.get('/pending', requireAuth, requireRole('faculty', 'admin'), reviewerList('queue'));
router.get('/history', requireAuth, requireRole('faculty', 'admin'), reviewerList('history'));

/** GET /activities/review/summary - the faculty dashboard numbers, limited to this reviewer's scope. */
router.get('/review/summary', requireAuth, requireRole('faculty', 'admin'), handle(async (req, res) => {
  res.json(await reviewSummary(req.user));
}));

/**
 * Retrieve audit log timeline for a specific activity.
 */
// 404 for a missing activity AND for someone else's draft (drafts are private to the student who wrote them);
// 403 when the activity exists but this reviewer's scope does not include the student.
async function viewableActivity(req, res, id) {
  const r = await pool.query('SELECT id, student_id, status, version FROM activities WHERE id = $1', [id]);
  const a = r.rows[0];
  if (!a || (a.status === 'draft' && a.student_id !== req.user.id)) {
    res.status(404).json({ error: 'Activity not found' });
    return null;
  }
  if (!(await canView(req, a.student_id))) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return null;
  }
  return a;
}

router.get('/:id/audit', requireAuth, handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid activity id');
  if (!(await viewableActivity(req, res, id))) return;
  const r = await pool.query(
    `SELECT audit_log.*, users.name AS reviewer_name
     FROM audit_log LEFT JOIN users ON users.id = audit_log.reviewer_id
     WHERE activity_id = $1 ORDER BY audit_log.created_at ASC, audit_log.id ASC`,
    [id]
  );
  res.json(r.rows);
}));

/** GET /activities/:id/versions - every submission of this activity (details, proof info, student's note). */
router.get('/:id/versions', requireAuth, handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid activity id');
  const a = await viewableActivity(req, res, id);
  if (!a) return;
  const r = await pool.query(
    `SELECT version, title, category, description, academic_session, semester,
            proof_original_name, proof_mime_type, proof_size, file_hash, is_duplicate, note, created_at,
            (proof_file_path IS NOT NULL) AS has_proof
     FROM activity_versions WHERE activity_id = $1 ORDER BY version ASC`,
    [id]
  );
  res.json({ current_version: a.version, versions: r.rows });
}));

/** Serve a protected proof document: the current one, or an earlier version with ?version=N. */
router.get('/:id/proof', requireAuth, handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid activity id');
  const a = await viewableActivity(req, res, id);
  if (!a) return;
  let file;
  if (req.query.version !== undefined) {
    const v = parseId(req.query.version);
    if (!v) throw fail(400, 'Invalid version');
    file = (await pool.query(
      'SELECT proof_file_path, proof_mime_type, proof_original_name FROM activity_versions WHERE activity_id = $1 AND version = $2', [id, v])).rows[0];
  } else {
    file = (await pool.query('SELECT proof_file_path, proof_mime_type, proof_original_name FROM activities WHERE id = $1', [id])).rows[0];
  }
  if (!file) return res.status(404).json({ error: 'Version not found' });
  if (!file.proof_file_path || !fs.existsSync(file.proof_file_path)) {
    return res.status(404).json({ error: 'Proof file is not available on disk' });
  }
  res.setHeader('Content-Type', file.proof_mime_type || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${String(file.proof_original_name || 'proof').replace(/["\\\r\n]/g, '_')}"`);
  fs.createReadStream(file.proof_file_path).pipe(res);
}));

/** Retrieve single activity details with student and reviewer info. */
router.get('/:id', requireAuth, handle(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid activity id');
  if (!(await viewableActivity(req, res, id))) return;
  const r = await pool.query(
    `SELECT activities.*,
            users.name AS student_name, users.email AS student_email, users.department,
            reviewer.name AS reviewer_name
     FROM activities
     JOIN users ON users.id = activities.student_id
     LEFT JOIN users reviewer ON reviewer.id = activities.reviewer_id
     WHERE activities.id = $1`,
    [id]
  );
  const out = toClient(r.rows[0], req.user.role);
  // Reviewers see WHICH earlier submission shared the file, but only if that student is also inside their scope.
  if (req.user.role !== 'student' && out.duplicate_of) {
    const other = await pool.query(
      `SELECT activities.id, activities.title, activities.status, activities.student_id, users.name AS student_name
       FROM activities JOIN users ON users.id = activities.student_id WHERE activities.id = $1 AND activities.status <> 'draft'`,
      [out.duplicate_of]
    );
    const o = other.rows[0];
    if (o && (await canAccessStudent(pool, req.user, o.student_id))) {
      out.duplicate_info = { id: o.id, title: o.title, status: o.status, student_name: o.student_name };
    } else {
      out.duplicate_of = null;
      out.duplicate_info = { out_of_scope: true };
    }
  }
  res.json(out);
}));

// ---------------------------------------------------------------- review decisions
const DECISIONS = {
  approve: { status: 'approved', remarks: 'optional', field: 'review_remarks' },
  reject: { status: 'rejected', remarks: 'required', field: 'review_remarks' },
  'request-correction': { status: 'correction_requested', remarks: 'required', field: 'correction_notes' },
};

/**
 * One handler for approve / reject / request-correction, so every decision follows the same rules:
 *  - the row is locked (FOR UPDATE) so two reviewers cannot decide the same submission at once;
 *  - only transitions in utils/lifecycle.js are allowed (a second decision on a decided record is a 409);
 *  - reject and request-correction need written remarks (approval may have them);
 *  - if the reviewer says which version they looked at (expected_version) and the student has resubmitted
 *    since, the decision is refused: a reviewer must never approve evidence they have not seen;
 *  - the status change, audit entry and student notification commit together or not at all.
 */
const decide = (kind) => handle(async (req, res) => {
  const rule = DECISIONS[kind];
  const id = parseId(req.params.id);
  if (!id) throw fail(400, 'Invalid activity id');

  const raw = req.body.remarks ?? req.body.notes ?? req.body.correction_notes ?? '';
  const remarks = String(raw).trim();
  if (rule.remarks === 'required' && !remarks) {
    throw fail(400, kind === 'reject' ? 'A rejection remark is required' : 'Correction instructions/notes are required', { fields: { remarks: 'Write a short explanation for the student.' } });
  }
  if (remarks.length > LIMITS.remarksMax) throw fail(400, `Remarks can be at most ${LIMITS.remarksMax} characters.`, { fields: { remarks: 'Too long.' } });
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(remarks)) throw fail(400, 'Remarks contain unsupported characters.', { fields: { remarks: 'Remove control characters.' } });
  const expected = req.body.expected_version;
  if (expected !== undefined && expected !== null && !Number.isInteger(Number(expected))) throw fail(400, 'expected_version must be a whole number');

  const updated = await inTransaction(async (client) => {
    const existing = await client.query('SELECT * FROM activities WHERE id = $1 FOR UPDATE', [id]);
    const activity = existing.rows[0];
    if (!activity || activity.status === 'draft') throw fail(404, 'Activity not found'); // drafts are private to their author
    if (!(await canAccessStudent(client, req.user, activity.student_id))) throw fail(403, 'This student is outside your verification scope');
    const problem = transitionProblem(activity.status, rule.status, req.user.role);
    if (problem) throw fail(409, problem);
    if (expected !== undefined && expected !== null && Number(expected) !== activity.version) {
      throw fail(409, 'The student resubmitted this activity after you opened it. Reload to review the latest version before deciding.',
        { code: 'STALE_VERSION', current_version: activity.version });
    }

    // Correction notes live in their own column so the "approved" remarks of an earlier round are never mixed up with them.
    const u = await client.query(
      `UPDATE activities SET status = $1, reviewer_id = $2, reviewed_at = NOW(), ${rule.field} = $3
       WHERE id = $4 RETURNING *`,
      [rule.status, req.user.id, remarks || null, id]
    );
    await logAudit(client, {
      activityId: id, studentId: activity.student_id, reviewerId: req.user.id,
      oldStatus: activity.status, newStatus: rule.status, remarks, version: activity.version,
    });
    // An administrator deciding a record is an override of the normal faculty process: it goes in the administrator log too.
    if (req.user.role === 'admin') {
      await logAdminAudit(client, {
        actorId: req.user.id, actorLabel: req.user.email, action: 'REVIEW_OVERRIDE', targetType: 'activity', targetId: id,
        details: { decision: rule.status, from: activity.status, version: activity.version, student_id: activity.student_id },
      });
    }
    const short = remarks.length > 80 ? `${remarks.slice(0, 80)}...` : remarks;
    const note = {
      approved: { title: 'Activity Approved! 🎉', message: `Your activity "${activity.title}" has been verified and approved.`, type: 'success' },
      rejected: { title: 'Activity Rejected', message: `Your activity "${activity.title}" was rejected: ${short}`, type: 'error' },
      correction_requested: { title: 'Correction Requested', message: `Faculty requested corrections on "${activity.title}": ${short}`, type: 'warning' },
    }[rule.status];
    await createNotification(client, { userId: activity.student_id, ...note, link: `/activity/${id}` });
    return u.rows[0];
  });
  res.json(toClient(updated, req.user.role));
});

router.patch('/:id/approve', requireAuth, requireRole('faculty', 'admin'), decide('approve'));
router.patch('/:id/reject', requireAuth, requireRole('faculty', 'admin'), decide('reject'));
router.patch('/:id/request-correction', requireAuth, requireRole('faculty', 'admin'), decide('request-correction'));

module.exports = router;
