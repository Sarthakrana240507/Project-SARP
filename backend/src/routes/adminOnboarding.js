// Admin: student and faculty bulk import (CSV preview -> confirm), import history, activation links.
const express = require('express');
const multer = require('multer');
const path = require('path');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { parseCsv } = require('../utils/csv');
const { programmeKey, REQUIRED_COLUMNS, normHeader, validateStudentRow, FACULTY_COLUMNS, FACULTY_OPTIONAL_COLUMNS, validateFacultyRow } = require('../utils/validation');
const { issueToken, buildLink } = require('../utils/tokens');
const { emailEnabled, sendMail, activationEmail, resetEmail } = require('../utils/mailer');
const { logAdminAudit } = require('../utils/adminAudit');
const { sendInvitation } = require('../utils/invite');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const MAX_ROWS = 5000;
const MAX_STORED_ERRORS = 1000;
const PREVIEW_TTL_HOURS = 24;

// CSV is parsed in memory and never written to disk. 2 MB comfortably holds 5000 rows.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname || '').toLowerCase() !== '.csv') {
      return cb(Object.assign(new Error('Only .csv files are accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});
const uploadCsv = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'CSV file is too large (maximum 2 MB)' });
    return res.status(err.status || 400).json({ error: err.message || 'Invalid upload' });
  });

const actorLabel = async (id) => (await pool.query('SELECT email FROM users WHERE id = $1', [id])).rows[0]?.email || null;

// One import pipeline serves both kinds. Everything that differs lives in this table.
const KINDS = {
  STUDENT: {
    path: 'students', noun: 'student', idField: 'student_id', idColumn: 'enrollment_no',
    required: REQUIRED_COLUMNS, validate: validateStudentRow, audit: 'STUDENT_IMPORT',
  },
  FACULTY: {
    path: 'faculty', noun: 'faculty', idField: 'faculty_id', idColumn: 'employee_id',
    required: FACULTY_COLUMNS, validate: validateFacultyRow, audit: 'FACULTY_IMPORT',
  },
};
for (const [key, k] of Object.entries(KINDS)) k.name = key;

/**
 * Preview: parses and validates the CSV, stores the validated rows as a PREVIEW batch, and returns a
 * row-by-row report. NOTHING is written to the users table until confirm is called.
 */
const previewHandler = (kind) => async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a CSV file to upload' });
    const buf = req.file.buffer;
    if (buf.includes(0)) return res.status(400).json({ error: 'This does not look like a text CSV file' });
    const text = buf.toString('utf8');
    if (text.includes('�')) return res.status(400).json({ error: 'The file must be UTF-8 encoded. Re-save it from Excel as "CSV UTF-8".' });

    let records;
    try { ({ records } = parseCsv(text)); } catch (e) { return res.status(400).json({ error: `CSV format error: ${e.message}` }); }
    if (records.length === 0) return res.status(400).json({ error: 'The file is empty' });

    const header = records[0].fields.map(normHeader);
    const missing = kind.required.filter((c) => !header.includes(c));
    if (missing.length) {
      return res.status(400).json({ error: `Missing required column(s): ${missing.join(', ')}`, required_columns: kind.required, missing });
    }
    const seenCols = new Set();
    for (const h of header) {
      if (seenCols.has(h)) return res.status(400).json({ error: `Column "${h}" appears more than once` });
      seenCols.add(h);
    }
    const dataRecords = records.slice(1);
    if (dataRecords.length === 0) return res.status(400).json({ error: `The file has a header but no ${kind.noun} rows` });
    if (dataRecords.length > MAX_ROWS) return res.status(400).json({ error: `Too many rows (${dataRecords.length}). Maximum is ${MAX_ROWS} per file.` });

    // Department lookup accepts either the code (CSE) or the full name; the canonical name is stored.
    const depts = await pool.query('SELECT code, name, is_active FROM departments');
    const deptLookup = new Map();
    for (const d of depts.rows) {
      deptLookup.set(d.code.toLowerCase(), d);
      deptLookup.set(d.name.toLowerCase(), d);
    }

    const programmeLookup = new Map();
    for (const p of (await pool.query('SELECT name, is_active FROM programmes')).rows) programmeLookup.set(programmeKey(p.name), p);
    // The code is accepted too ("BTECH" and "B.Tech" both resolve to the configured name).
    for (const p of (await pool.query('SELECT code, name, is_active FROM programmes')).rows) programmeLookup.set(programmeKey(p.code), p);

    const errors = [];
    const valid = [];
    const firstSeenId = new Map();
    const firstSeenEmail = new Map();
    const idCol = header.indexOf(kind.idField);

    for (const rec of dataRecords) {
      if (rec.fields.length !== header.length) {
        errors.push({ line: rec.line, [kind.idField]: rec.fields[idCol] || '', messages: [`expected ${header.length} columns but found ${rec.fields.length}`] });
        continue;
      }
      const raw = {};
      header.forEach((h, i) => { raw[h] = rec.fields[i]; });
      const v = kind.validate(raw, { deptLookup, programmeLookup });
      const messages = [...v.errors];
      if (v.idValue) {
        if (firstSeenId.has(v.idValue)) messages.push(`duplicate ${kind.idField} (first seen on line ${firstSeenId.get(v.idValue)})`);
        else firstSeenId.set(v.idValue, rec.line);
      }
      if (v.email) {
        if (firstSeenEmail.has(v.email)) messages.push(`duplicate email (first seen on line ${firstSeenEmail.get(v.email)})`);
        else firstSeenEmail.set(v.email, rec.line);
      }
      if (messages.length) errors.push({ line: rec.line, [kind.idField]: v.idValue || '', messages });
      else valid.push({ line: rec.line, ...v.value });
    }

    // Conflicts with accounts that already exist in the database.
    const ids = valid.map((r) => r[kind.idField]);
    const emails = valid.map((r) => r.email);
    if (valid.length) {
      const ex = await pool.query(
        `SELECT UPPER(${kind.idColumn}) AS sid, LOWER(email) AS em FROM users
         WHERE UPPER(${kind.idColumn}) = ANY($1) OR LOWER(email) = ANY($2)`,
        [ids, emails]
      );
      const existingIds = new Set(ex.rows.map((r) => r.sid));
      const existingEmails = new Set(ex.rows.map((r) => r.em));
      for (let i = valid.length - 1; i >= 0; i--) {
        const r = valid[i];
        const m = [];
        if (existingIds.has(r[kind.idField])) m.push(`${kind.idField} already exists in SARP`);
        if (existingEmails.has(r.email)) m.push('email is already registered in SARP');
        if (m.length) { errors.push({ line: r.line, [kind.idField]: r[kind.idField], messages: m }); valid.splice(i, 1); }
      }
    }
    errors.sort((a, b) => a.line - b.line);

    // Housekeeping: stale previews can no longer be confirmed.
    await pool.query(
      `UPDATE import_batches SET status = 'CANCELLED', payload = NULL
       WHERE status = 'PREVIEW' AND created_at < NOW() - make_interval(hours => $1)`,
      [PREVIEW_TTL_HOURS]
    );

    const batch = await pool.query(
      `INSERT INTO import_batches (kind, filename, uploaded_by, status, total_rows, valid_rows, error_rows, payload, errors)
       VALUES ($8, $1, $2, 'PREVIEW', $3, $4, $5, $6, $7) RETURNING id, created_at`,
      [String(req.file.originalname).slice(0, 200), req.user.id, dataRecords.length, valid.length, errors.length,
        JSON.stringify(valid), JSON.stringify(errors.slice(0, MAX_STORED_ERRORS)), kind.name]
    );

    res.json({
      batch_id: batch.rows[0].id,
      total_rows: dataRecords.length,
      valid_rows: valid.length,
      error_rows: errors.length,
      errors: errors.slice(0, MAX_STORED_ERRORS),
      errors_truncated: errors.length > MAX_STORED_ERRORS,
      sample: valid.slice(0, 10).map(({ line, ...r }) => r),
      expires_in_hours: PREVIEW_TTL_HOURS,
    });
  } catch (err) {
    console.error('Import preview error:', err);
    res.status(500).json({ error: 'Could not process the CSV file' });
  }
};

/**
 * Confirm: creates every VALID row as an INVITED account in ONE transaction (all valid rows commit
 * together or none do). Rows that became duplicates since the preview are skipped and
 * reported, never overwritten. Passwords are never generated.
 */
const confirmHandler = (kind) => async (req, res) => {
  const batchId = Number(req.params.id);
  if (!Number.isInteger(batchId)) return res.status(400).json({ error: 'Invalid import ID' });
  const client = await pool.connect();
  let insertedIds = [];
  let summary;
  try {
    await client.query('BEGIN');
    // Expiry is computed by PostgreSQL (same clock and timezone that wrote created_at).
    const b = (await client.query(
      `SELECT *, (created_at < NOW() - make_interval(hours => $2)) AS expired FROM import_batches WHERE id = $1 FOR UPDATE`,
      [batchId, PREVIEW_TTL_HOURS]
    )).rows[0];
    if (!b || b.kind !== kind.name) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Import not found' }); }
    if (b.status !== 'PREVIEW') { await client.query('ROLLBACK'); return res.status(409).json({ error: `This import was already ${b.status.toLowerCase()}.` }); }
    if (b.expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This preview has expired. Upload the file again.' });
    }
    const rows = b.payload || [];
    if (rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'There are no valid rows to import' }); }

    let ins;
    if (kind.name === 'STUDENT') {
      ins = await client.query(
        `INSERT INTO users (name, email, role, status, is_active, enrollment_no, department, programme, academic_year, semester, invited_at, import_batch_id)
         SELECT t.name, t.email, 'student', 'INVITED', FALSE, t.student_id, t.department, t.programme, t.academic_year, t.semester, NOW(), $8
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS t(name, email, student_id, department, programme, academic_year, semester)
         ON CONFLICT DO NOTHING
         RETURNING id, enrollment_no AS ident, department`,
        [rows.map((r) => r.name), rows.map((r) => r.email), rows.map((r) => r.student_id), rows.map((r) => r.department),
          rows.map((r) => r.programme), rows.map((r) => r.academic_year), rows.map((r) => r.semester), batchId]
      );
    } else {
      ins = await client.query(
        `INSERT INTO users (name, email, role, status, is_active, employee_id, department, designation, invited_at, import_batch_id)
         SELECT t.name, t.email, 'faculty', 'INVITED', FALSE, t.faculty_id, t.department, NULLIF(t.designation, ''), NOW(), $6
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS t(name, email, faculty_id, department, designation)
         ON CONFLICT DO NOTHING
         RETURNING id, employee_id AS ident, department`,
        [rows.map((r) => r.name), rows.map((r) => r.email), rows.map((r) => r.faculty_id), rows.map((r) => r.department),
          rows.map((r) => r.designation || ''), batchId]
      );
      // New faculty start with their own department only; an administrator can widen it later.
      for (const u of ins.rows) {
        await client.query('INSERT INTO faculty_scopes (faculty_id, department, created_by) VALUES ($1, $2, $3)', [u.id, u.department, req.user.id]);
      }
    }
    insertedIds = ins.rows.map((r) => r.id);
    const insertedSet = new Set(ins.rows.map((r) => r.ident));
    const skipped = rows.filter((r) => !insertedSet.has(r[kind.idField]))
      .map((r) => ({ line: r.line, [kind.idField]: r[kind.idField], messages: ['became a duplicate before the import was confirmed; skipped'] }));

    summary = { imported: insertedIds.length, failed: skipped.length + b.error_rows, skipped_at_confirm: skipped.length };
    await client.query(
      `UPDATE import_batches SET status = 'COMMITTED', imported_count = $2, failed_count = $3, committed_at = NOW(),
              payload = NULL, errors = $4 WHERE id = $1`,
      [batchId, summary.imported, summary.failed, JSON.stringify([...(b.errors || []), ...skipped].slice(0, MAX_STORED_ERRORS))]
    );
    await logAdminAudit(client, {
      actorId: req.user.id, actorLabel: await actorLabel(req.user.id), action: kind.audit,
      targetType: 'import_batch', targetId: batchId,
      details: { filename: b.filename, imported: summary.imported, failed: summary.failed },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Import confirm error:', err);
    return res.status(500).json({ error: 'The import failed and nothing was saved.' });
  } finally {
    client.release();
  }

  // Invitations by email only when a mail service is actually configured; runs after the
  // response so a slow mail server cannot block or roll back the import.
  const emailing = emailEnabled() && insertedIds.length > 0;
  if (emailing) sendBatchInvitations(batchId, insertedIds, req.user.id).catch((e) => console.error('Invitation run failed:', e.message));

  res.json({
    batch_id: batchId,
    ...summary,
    invitations: emailing
      ? { mode: 'EMAIL', note: 'Invitation emails are being sent. Check import history for the final count.' }
      : { mode: 'NONE', note: `Email delivery is not configured, so no emails were sent. Use "Activation links" to hand links to the ${kind.noun === 'faculty' ? 'faculty members' : 'students'}.` },
  });
};

async function sendBatchInvitations(batchId, userIds, adminId) {
  let sent = 0;
  let failed = 0;
  for (const id of userIds) {
    try {
      const r = await sendInvitation(pool, id, adminId);
      if (r.sent) sent++; else failed++;
    } catch { failed++; }
  }
  await pool.query('UPDATE import_batches SET invites_sent = $2, invites_failed = $3 WHERE id = $1', [batchId, sent, failed]);
}

/** Cancel: discards an unconfirmed preview. */
const cancelHandler = (kind) => async (req, res) => {
  const r = await pool.query(
    `UPDATE import_batches SET status = 'CANCELLED', payload = NULL WHERE id = $1 AND kind = $2 AND status = 'PREVIEW' RETURNING id`,
    [Number(req.params.id) || 0, kind.name]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'No pending preview found with that ID' });
  res.json({ success: true });
};

for (const kind of Object.values(KINDS)) {
  router.post(`/${kind.path}/import/preview`, uploadCsv, previewHandler(kind));
  router.post(`/${kind.path}/import/:id/confirm`, confirmHandler(kind));
  router.post(`/${kind.path}/import/:id/cancel`, cancelHandler(kind));
}

/** GET /admin/imports - import history (newest first). */
router.get('/imports', async (req, res) => {
  try {
    const kindName = String(req.query.kind || '').toUpperCase();
    const r = await pool.query(
      `SELECT b.id, b.filename, b.status, b.total_rows, b.valid_rows, b.error_rows, b.imported_count, b.failed_count,
              b.kind, b.invites_sent, b.invites_failed, b.created_at, b.committed_at, u.name AS uploaded_by_name,
              (SELECT COUNT(*)::int FROM users x WHERE x.import_batch_id = b.id AND x.status = 'INVITED') AS still_invited
       FROM import_batches b LEFT JOIN users u ON u.id = b.uploaded_by
       WHERE ($1 = '' OR b.kind = $1) ORDER BY b.created_at DESC LIMIT 100`,
      [KINDS[kindName] ? kindName : '']
    );
    res.json({ imports: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load import history' });
  }
});

/** GET /admin/imports/:id - one import with its row-level errors. */
router.get('/imports/:id', async (req, res) => {
  const r = await pool.query(
    `SELECT id, kind, filename, status, total_rows, valid_rows, error_rows, imported_count, failed_count, invites_sent, invites_failed, errors, created_at, committed_at
     FROM import_batches WHERE id = $1`, [Number(req.params.id) || 0]);
  if (!r.rows.length) return res.status(404).json({ error: 'Import not found' });
  res.json({ import: r.rows[0] });
});

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/**
 * POST /admin/imports/:id/activation-links
 * Administrator-assisted activation when email is unavailable: issues a fresh one-time link for
 * every student from this import who has not activated yet and returns them as a CSV download.
 * The links exist only in this response (the database keeps only hashes). Audit-logged.
 */
router.post('/imports/:id/activation-links', async (req, res) => {
  const batchId = Number(req.params.id);
  const client = await pool.connect();
  try {
    const b = (await client.query(`SELECT id, status, kind FROM import_batches WHERE id = $1`, [batchId])).rows[0];
    if (!b) return res.status(404).json({ error: 'Import not found' });
    if (b.status !== 'COMMITTED') return res.status(409).json({ error: 'Only a confirmed import has accounts' });

    await client.query('BEGIN');
    const users = (await client.query(
      `SELECT id, COALESCE(enrollment_no, employee_id) AS ident, name, email FROM users WHERE import_batch_id = $1 AND status = 'INVITED' ORDER BY 2`, [batchId])).rows;
    const lines = [`${b.kind === 'FACULTY' ? 'faculty_id' : 'student_id'},name,email,activation_link,expires_at`];
    for (const u of users) {
      const { token, expires_at } = await issueToken(client, { userId: u.id, purpose: 'ACTIVATION', delivery: 'ADMIN_HANDOFF', createdBy: req.user.id });
      lines.push([u.ident, u.name, u.email, buildLink('ACTIVATION', token), new Date(expires_at).toISOString()].map(csvCell).join(','));
    }
    await logAdminAudit(client, {
      actorId: req.user.id, actorLabel: await actorLabel(req.user.id), action: 'ACTIVATION_LINKS_GENERATED',
      targetType: 'import_batch', targetId: batchId, details: { count: users.length },
    });
    await client.query('COMMIT');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="activation-links-import-${batchId}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(lines.join('\r\n') + '\r\n');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Activation links error:', err);
    res.status(500).json({ error: 'Could not generate activation links' });
  } finally {
    client.release();
  }
});

/**
 * POST /admin/users/:id/activation-link   body: { delivery?: 'EMAIL' | 'HANDOFF' }
 * INVITED account -> activation link. ACTIVE account -> password-reset link.
 * HANDOFF (default when email is not configured) returns the link once to this administrator;
 * EMAIL sends it and returns nothing sensitive.
 */
router.post('/users/:id/activation-link', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });
    const u = (await pool.query('SELECT id, name, email, role, status FROM users WHERE id = $1', [id])).rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.role === 'admin') {
      // Handing out a link for an administrator account is equivalent to taking it over: Super Admin only, never for yourself.
      if (!req.user.isSuperAdmin) return res.status(403).json({ error: 'Only a Super Admin can issue links for administrator accounts', code: 'SUPER_ADMIN_REQUIRED' });
      if (u.id === req.user.id) return res.status(400).json({ error: 'Use the password-change option in your profile instead' });
    }
    if (u.status === 'SUSPENDED') return res.status(409).json({ error: 'This account is suspended. Reactivate it first.' });

    const purpose = u.status === 'INVITED' ? 'ACTIVATION' : 'PASSWORD_RESET';
    const wantEmail = req.body.delivery ? req.body.delivery === 'EMAIL' : emailEnabled();
    if (wantEmail && !emailEnabled()) return res.status(409).json({ error: 'Email delivery is not configured on this server. Use hand-off delivery.' });

    const { token, expires_at } = await issueToken(pool, { userId: id, purpose, delivery: wantEmail ? 'EMAIL' : 'ADMIN_HANDOFF', createdBy: req.user.id });
    const link = buildLink(purpose, token);
    let emailSent = false;
    if (wantEmail) {
      const mail = purpose === 'ACTIVATION'
        ? activationEmail({ name: u.name, link, hours: Math.round(Number(process.env.INVITE_TTL_HOURS || 168)) })
        : resetEmail({ name: u.name, link, minutes: Number(process.env.RESET_TTL_MINUTES || 60) });
      emailSent = (await sendMail({ to: u.email, ...mail })).sent;
      if (!emailSent) {
        await pool.query(`UPDATE auth_tokens SET revoked_at = NOW() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [id]);
        return res.status(502).json({ error: 'The email could not be sent. Try hand-off delivery instead.' });
      }
    }
    await logAdminAudit(pool, {
      actorId: req.user.id, actorLabel: await actorLabel(req.user.id),
      action: purpose === 'ACTIVATION' ? 'ACTIVATION_LINK_ISSUED' : 'PASSWORD_RESET_LINK_ISSUED',
      targetType: 'user', targetId: id, details: { delivery: wantEmail ? 'EMAIL' : 'ADMIN_HANDOFF' },
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ purpose, expires_at, email_sent: emailSent, ...(wantEmail ? {} : { link }) });
  } catch (err) {
    console.error('Link generation error:', err);
    res.status(500).json({ error: 'Could not generate the link' });
  }
});

module.exports = router;
