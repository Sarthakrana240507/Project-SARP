const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createNotification } = require('../utils/notifications');
const { logAdminAudit } = require('../utils/adminAudit');
const { setScope } = require('../utils/scope');

const router = express.Router();

// Enforce admin role for all routes in this router
router.use(requireAuth, requireRole('admin'));

// True when `targetId` is the only active Super Admin (suspending or demoting it would lock everyone out).
const isLastActiveSuperAdmin = async (db, targetId) => {
  const n = (await db.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_super_admin AND status = 'ACTIVE' AND id <> $1`, [targetId])).rows[0].n;
  return n === 0;
};

const actorEmail = async (db, id) => (await db.query('SELECT email FROM users WHERE id = $1', [id])).rows[0]?.email || null;

/**
 * GET /admin/overview
 * Returns administrative KPI metrics.
 */
router.get('/overview', async (_req, res) => {
  try {
    const [countsResult, activityStatsResult, duplicateResult] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_users,
          COUNT(*) FILTER (WHERE role = 'student')::int AS total_students,
          COUNT(*) FILTER (WHERE role = 'faculty')::int AS total_faculty,
          COUNT(*) FILTER (WHERE status = 'SUSPENDED')::int AS deactivated_users
        FROM users
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status <> 'draft')::int AS total_activities,
          COUNT(*) FILTER (WHERE status IN ('pending', 'resubmitted'))::int AS pending,
          COUNT(*) FILTER (WHERE status = 'resubmitted')::int AS resubmitted,
          COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
          COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
          COUNT(*) FILTER (WHERE status = 'correction_requested')::int AS correction_requested,
          COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts
        FROM activities
      `),
      pool.query(`
        SELECT COUNT(*)::int AS duplicate_flags
        FROM activities
        WHERE is_duplicate = true AND status <> 'draft'
      `),
    ]);

    res.json({
      users: countsResult.rows[0],
      activities: activityStatsResult.rows[0],
      duplicate_flags: duplicateResult.rows[0]?.duplicate_flags || 0,
    });
  } catch (err) {
    console.error('Admin overview error:', err);
    res.status(500).json({ error: 'Failed to retrieve administrative overview' });
  }
});

/**
 * GET /admin/users
 * Paginated and filtered user list (never returns password_hash).
 */
router.get('/users', async (req, res) => {
  try {
    const { role, department, is_active, account_status, search, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, Number(page));
    const pageLimit = Math.min(100, Math.max(1, Number(limit)));
    const offset = (pageNum - 1) * pageLimit;

    let query = `
      SELECT id, name, email, role, department, enrollment_no, employee_id, designation, is_super_admin, programme, academic_year, semester, status, (status = 'ACTIVE') AS is_active, created_at, activated_at
      FROM users
      WHERE 1=1
    `;
    const params = [];

    if (role && ['student', 'faculty', 'admin'].includes(role)) {
      params.push(role);
      query += ` AND role = $${params.length}`;
    }
    if (department && department !== 'all') {
      params.push(department);
      query += ` AND department = $${params.length}`;
    }
    if (['INVITED', 'ACTIVE', 'SUSPENDED'].includes(account_status)) {
      params.push(account_status);
      query += ` AND status = $${params.length}`;
    }
    if (is_active !== undefined && is_active !== '') {
      params.push(is_active === 'true' ? 'ACTIVE' : 'SUSPENDED');
      query += ` AND status = $${params.length}`;
    }
    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      query += ` AND (LOWER(name) LIKE $${params.length} OR LOWER(email) LIKE $${params.length} OR LOWER(COALESCE(enrollment_no, '')) LIKE $${params.length})`;
    }

    // Count query
    const countSql = `SELECT COUNT(*)::int AS total FROM (${query}) AS filtered`;
    const countRes = await pool.query(countSql, params);
    const totalUsers = countRes.rows[0]?.total || 0;

    // Ordered & paginated results
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(pageLimit, offset);

    const listRes = await pool.query(query, params);

    res.json({
      users: listRes.rows,
      pagination: {
        page: pageNum,
        limit: pageLimit,
        total: totalUsers,
        pages: Math.ceil(totalUsers / pageLimit),
      },
    });
  } catch (err) {
    console.error('Error fetching admin users:', err);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

/**
 * PATCH /admin/users/:id/status
 * Activate or deactivate an account.
 */
router.patch('/users/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });

    // Accepts { status: 'ACTIVE' | 'SUSPENDED' } or the legacy { is_active: boolean }.
    let target = req.body.status;
    if (target === undefined && typeof req.body.is_active === 'boolean') {
      target = req.body.is_active ? 'ACTIVE' : 'SUSPENDED';
    }
    if (!['ACTIVE', 'SUSPENDED'].includes(target)) {
      return res.status(400).json({ error: "status must be 'ACTIVE' or 'SUSPENDED'" });
    }
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Administrators cannot deactivate their own account.' });
    }

    const existing = await pool.query('SELECT status, role, is_super_admin FROM users WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    // Administrator accounts can only be suspended/reactivated by a Super Admin.
    if (existing.rows[0].role === 'admin' && !req.user.isSuperAdmin) {
      return res.status(403).json({ error: 'Only a Super Admin can change an administrator account', code: 'SUPER_ADMIN_REQUIRED' });
    }
    if (target === 'SUSPENDED' && existing.rows[0].is_super_admin && await isLastActiveSuperAdmin(pool, id)) {
      return res.status(409).json({ error: 'The last active Super Admin cannot be suspended', code: 'LAST_SUPER_ADMIN' });
    }
    // An INVITED account has no password yet; it becomes ACTIVE only through activation.
    if (existing.rows[0].status === 'INVITED') {
      return res.status(409).json({ error: 'This account has not been activated by its owner yet.' });
    }

    const result = await pool.query(
      `UPDATE users
       SET status = $1, is_active = ($1 = 'ACTIVE')
       WHERE id = $2
       RETURNING id, name, email, role, department, status, is_active`,
      [target, id]
    );
    const updatedUser = result.rows[0];
    const active = target === 'ACTIVE';
    await logAdminAudit(pool, {
      actorId: req.user.id, actorLabel: await actorEmail(pool, req.user.id), action: 'ACCOUNT_STATUS_CHANGED',
      targetType: 'user', targetId: id, details: { from: existing.rows[0].status, to: target, role: existing.rows[0].role },
    });

    await createNotification(pool, {
      userId: id,
      title: active ? 'Account Reactivated' : 'Account Suspended',
      message: active
        ? 'Your SARP institutional account has been reactivated by the administrator.'
        : 'Your account has been suspended. Please contact your department coordinator.',
      type: active ? 'success' : 'warning',
    });

    res.json({ user: updatedUser, message: `Account ${active ? 'activated' : 'suspended'} successfully` });
  } catch (err) {
    console.error('Error updating user status:', err);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

/**
 * PATCH /admin/users/:id/role
 * Change a user's role (student / faculty / admin).
 */
router.patch('/users/:id/role', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const { role } = req.body;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });
    if (!['student', 'faculty', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Allowed roles: student, faculty, admin' });
    }
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Administrators cannot change their own role.' });
    }

    await client.query('BEGIN');
    const cur = (await client.query('SELECT id, role, department FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
    if (cur.role === role) { await client.query('ROLLBACK'); return res.status(400).json({ error: `User is already ${role}` }); }

    // Creating or removing administrators is reserved for Super Admins.
    if ((role === 'admin' || cur.role === 'admin') && !req.user.isSuperAdmin) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only a Super Admin can assign or remove the administrator role', code: 'SUPER_ADMIN_REQUIRED' });
    }

    // is_super_admin is always cleared on a role change (the database CHECK also requires role = admin).
    // Because only another Super Admin can reach this point for an admin target, one always remains.
    const result = await client.query(
      `UPDATE users SET role = $1, is_super_admin = FALSE WHERE id = $2
       RETURNING id, name, email, role, department, status, (status = 'ACTIVE') AS is_active`,
      [role, id]
    );
    // Faculty scope follows the role: leaving faculty drops it; becoming faculty starts with the
    // user's own department (or no access if they have none) until an administrator widens it.
    if (cur.role === 'faculty') await client.query('DELETE FROM faculty_scopes WHERE faculty_id = $1', [id]);
    if (role === 'faculty') await setScope(client, id, { all: false, departments: cur.department ? [cur.department] : [] }, req.user.id);

    await logAdminAudit(client, {
      actorId: req.user.id, actorLabel: await actorEmail(client, req.user.id), action: 'ROLE_CHANGED',
      targetType: 'user', targetId: id, details: { from: cur.role, to: role },
    });
    await createNotification(client, {
      userId: id,
      title: 'Institutional Role Updated',
      message: `Your platform role has been changed to ${role.toUpperCase()} by the administrator.`,
      type: 'info',
    });
    await client.query('COMMIT');
    res.json({ user: result.rows[0], message: `User role updated to ${role}` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error changing user role:', err);
    res.status(500).json({ error: 'Failed to update user role' });
  } finally {
    client.release();
  }
});

// Categories, academic years, departments, programmes, academic assignment and the audit log viewer live in adminAcademic.js.

module.exports = router;

