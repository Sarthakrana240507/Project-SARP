const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

// Every query below is filtered by req.user.id, so a user can only ever see or change their own notifications.
const router = express.Router();
router.use(requireAuth);

const fail = (res, err, what) => { console.error(`Notifications ${what}:`, err.message); res.status(500).json({ error: `Failed to ${what}` }); };

/** GET /notifications?filter=all|unread&page=1&limit=20 -> { notifications, unread_count, total, page, limit, pages } */
router.get('/', async (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    if (!['all', 'unread'].includes(filter)) return res.status(400).json({ error: 'filter must be all or unread' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const where = filter === 'unread' ? 'user_id = $1 AND is_read = FALSE' : 'user_id = $1';
    const [list, total, unread] = await Promise.all([
      pool.query(
        `SELECT id, title, message, type, link, is_read, read_at, created_at FROM notifications
          WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, [req.user.id, limit, (page - 1) * limit]),
      pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE ${where}`, [req.user.id]),
      pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = FALSE`, [req.user.id]),
    ]);
    res.json({
      notifications: list.rows, unread_count: unread.rows[0].n,
      total: total.rows[0].n, page, limit, pages: Math.max(1, Math.ceil(total.rows[0].n / limit)),
    });
  } catch (err) { fail(res, err, 'retrieve notifications'); }
});

/** GET /notifications/unread-count -> { unread_count }  (cheap; the bell polls this) */
router.get('/unread-count', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = FALSE', [req.user.id]);
    res.json({ unread_count: r.rows[0].n });
  } catch (err) { fail(res, err, 'retrieve the unread count'); }
});

/** PATCH /notifications/read-all */
router.patch('/read-all', async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE user_id = $1 AND is_read = FALSE', [req.user.id]);
    res.json({ success: true, updated: r.rowCount, unread_count: 0 });
  } catch (err) { fail(res, err, 'update notifications'); }
});

/** PATCH /notifications/:id/read (idempotent: marking an already-read notification keeps its first read time) */
router.patch('/:id/read', async (req, res) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid notification id' });
    const r = await pool.query(
      `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, NOW())
        WHERE id = $1 AND user_id = $2
        RETURNING id, title, message, type, link, is_read, read_at, created_at`, [Number(req.params.id), req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Notification not found' });
    res.json(r.rows[0]);
  } catch (err) { fail(res, err, 'update the notification'); }
});

module.exports = router;
