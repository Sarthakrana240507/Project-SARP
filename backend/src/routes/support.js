const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { logAdminAudit } = require('../utils/adminAudit');
const { notifyAdmins, createNotification } = require('../utils/notifications');
const { likePattern } = require('../utils/activityInput');
const { CATEGORIES, STATUSES, LIMITS, validateTicket, clean } = require('../utils/supportInput');

// Two routers: `userRouter` (everyone signed in, own tickets only) and `adminRouter` (admins, all tickets).
// Internal admin notes are selected ONLY by the admin queries; user-facing queries use USER_COLS.
const userRouter = express.Router();
const adminRouter = express.Router();
userRouter.use(requireAuth);
adminRouter.use(requireAuth, requireRole('admin'));

const fail = (res, err, what) => { console.error(`Support ${what}:`, err.message); res.status(500).json({ error: `Failed to ${what}` }); };
const REF = /^SUP-\d{6,9}$/;
const USER_COLS = 'id, ticket_ref, name, email, category, subject, message, status, resolved_at, created_at, updated_at';
const ADMIN_COLS = `${USER_COLS}, admin_notes, user_id`;
const view = (row) => ({ ...row, category_label: CATEGORIES[row.category] || row.category });

// 5 new tickets per user per hour: enough for real problems, too few to flood the admins.
const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyFn: (req) => `u${req.user.id}`, message: 'You have sent several tickets recently. Please wait a while before sending another.' });

/** POST /support/tickets  { name, email, category, subject, message } -> 201 ticket */
userRouter.post('/tickets', async (req, res, next) => {
  // Validate first, then count the attempt: a typo in the form should not use up the hourly allowance.
  try {
    const acct = (await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id])).rows[0];
    const { values, errors } = validateTicket(req.body, acct?.email);
    if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors).join(' '), fields: errors });
    req.ticketInput = { values, accountEmail: acct.email };
    createLimiter(req, res, next);
  } catch (err) { fail(res, err, 'submit the ticket'); }
}, async (req, res) => {
  const db = await pool.connect();
  try {
    const { values, accountEmail } = req.ticketInput;
    await db.query('BEGIN');
    const t = (await db.query(
      `INSERT INTO support_tickets (user_id, name, email, category, subject, message) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${USER_COLS}`,
      [req.user.id, values.name, accountEmail, values.category, values.subject, values.message])).rows[0];
    await notifyAdmins(db, { title: 'New support ticket', message: `${t.ticket_ref}: ${t.subject}`.slice(0, 300), type: 'info', link: '/admin?tab=support' });
    await db.query('COMMIT');
    res.status(201).json(view(t));
  } catch (err) { await db.query('ROLLBACK').catch(() => {}); fail(res, err, 'submit the ticket'); }
  finally { db.release(); }
});

/** GET /support/tickets?status=&page=&limit=  -> the caller's own tickets */
userRouter.get('/tickets', async (req, res) => {
  try {
    const status = req.query.status;
    if (status && status !== 'all' && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status filter' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const params = [req.user.id]; let where = 'user_id = $1';
    if (status && status !== 'all') { params.push(status); where += ` AND status = $${params.length}`; }
    const [rows, total] = await Promise.all([
      pool.query(`SELECT ${USER_COLS} FROM support_tickets WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, (page - 1) * limit]),
      pool.query(`SELECT COUNT(*)::int AS n FROM support_tickets WHERE ${where}`, params),
    ]);
    res.json({ tickets: rows.rows.map(view), total: total.rows[0].n, page, limit, pages: Math.max(1, Math.ceil(total.rows[0].n / limit)) });
  } catch (err) { fail(res, err, 'retrieve your tickets'); }
});

/** GET /support/tickets/:ref  (own tickets only; someone else's ticket looks like it does not exist) */
userRouter.get('/tickets/:ref', async (req, res) => {
  try {
    if (!REF.test(req.params.ref)) return res.status(400).json({ error: 'Invalid ticket ID' });
    const r = await pool.query(`SELECT ${USER_COLS} FROM support_tickets WHERE ticket_ref = $1 AND user_id = $2`, [req.params.ref, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Ticket not found' });
    res.json(view(r.rows[0]));
  } catch (err) { fail(res, err, 'retrieve the ticket'); }
});

// ------------------------------------------------------------------ admin

/** GET /admin/support/tickets?search=&status=&category=&page=&limit= */
adminRouter.get('/tickets', async (req, res) => {
  try {
    const { status, category } = req.query;
    if (status && status !== 'all' && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status filter' });
    if (category && category !== 'all' && !CATEGORIES[category]) return res.status(400).json({ error: 'Invalid category filter' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 15));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const params = []; const where = [];
    if (status && status !== 'all') { params.push(status); where.push(`status = $${params.length}`); }
    if (category && category !== 'all') { params.push(category); where.push(`category = $${params.length}`); }
    const search = clean(req.query.search);
    if (search) { params.push(likePattern(search)); where.push(`(ticket_ref ILIKE $${params.length} OR subject ILIKE $${params.length} OR email ILIKE $${params.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows, total, counts] = await Promise.all([
      pool.query(`SELECT ${ADMIN_COLS} FROM support_tickets ${w} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, (page - 1) * limit]),
      pool.query(`SELECT COUNT(*)::int AS n FROM support_tickets ${w}`, params),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM support_tickets GROUP BY status`),
    ]);
    const byStatus = { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0 };
    counts.rows.forEach((c) => { byStatus[c.status] = c.n; });
    res.json({ tickets: rows.rows.map(view), total: total.rows[0].n, page, limit, pages: Math.max(1, Math.ceil(total.rows[0].n / limit)), counts: byStatus });
  } catch (err) { fail(res, err, 'retrieve tickets'); }
});

adminRouter.get('/tickets/:ref', async (req, res) => {
  try {
    if (!REF.test(req.params.ref)) return res.status(400).json({ error: 'Invalid ticket ID' });
    const r = await pool.query(`SELECT ${ADMIN_COLS} FROM support_tickets WHERE ticket_ref = $1`, [req.params.ref]);
    if (!r.rows.length) return res.status(404).json({ error: 'Ticket not found' });
    res.json(view(r.rows[0]));
  } catch (err) { fail(res, err, 'retrieve the ticket'); }
});

/** PATCH /admin/support/tickets/:ref  { status?, admin_notes? } */
adminRouter.patch('/tickets/:ref', async (req, res) => {
  const db = await pool.connect();
  try {
    if (!REF.test(req.params.ref)) return res.status(400).json({ error: 'Invalid ticket ID' });
    const { status, admin_notes: rawNotes } = req.body || {};
    if (status === undefined && rawNotes === undefined) return res.status(400).json({ error: 'Nothing to update' });
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: 'Status must be OPEN, IN_PROGRESS or RESOLVED' });
    let notes;
    if (rawNotes !== undefined) {
      notes = clean(rawNotes, true);
      if (notes.length > LIMITS.notes[1]) return res.status(400).json({ error: `Notes can be at most ${LIMITS.notes[1]} characters` });
    }
    await db.query('BEGIN');
    const cur = (await db.query('SELECT id, ticket_ref, user_id, status, admin_notes, subject FROM support_tickets WHERE ticket_ref = $1 FOR UPDATE', [req.params.ref])).rows[0];
    if (!cur) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Ticket not found' }); }
    const nextStatus = status ?? cur.status;
    const nextNotes = notes === undefined ? cur.admin_notes : (notes || null);
    const statusChanged = nextStatus !== cur.status;
    const notesChanged = (nextNotes || '') !== (cur.admin_notes || '');
    const updated = (await db.query(
      `UPDATE support_tickets SET status = $2, admin_notes = $3, updated_by = $4, updated_at = NOW(),
              resolved_at = CASE WHEN $2 = 'RESOLVED' THEN COALESCE(resolved_at, NOW()) ELSE NULL END
        WHERE id = $1 RETURNING ${ADMIN_COLS}`, [cur.id, nextStatus, nextNotes, req.user.id])).rows[0];
    if (statusChanged || notesChanged) {
      // The audit entry records that notes changed, never their text.
      await logAdminAudit(db, { actorId: req.user.id, action: 'SUPPORT_TICKET_UPDATED', targetType: 'support_ticket', targetId: cur.ticket_ref,
        details: { from: cur.status, to: nextStatus, notes_changed: notesChanged } });
    }
    if (statusChanged && cur.user_id) {
      const label = { OPEN: 'reopened', IN_PROGRESS: 'now in progress', RESOLVED: 'resolved' }[nextStatus];
      await createNotification(db, { userId: cur.user_id, title: 'Support ticket updated', message: `Your ticket ${cur.ticket_ref} is ${label}.`, type: nextStatus === 'RESOLVED' ? 'success' : 'info', link: '/support' });
    }
    await db.query('COMMIT');
    res.json(view(updated));
  } catch (err) { await db.query('ROLLBACK').catch(() => {}); fail(res, err, 'update the ticket'); }
  finally { db.release(); }
});

module.exports = { userRouter, adminRouter };
