// Admin: faculty provisioning, verification scope, and (Super Admin only) administrator management.
const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole, requireSuperAdmin } = require('../middleware/auth');
const { validateFacultyRow } = require('../utils/validation');
const { getScope, setScope } = require('../utils/scope');
const { logAdminAudit } = require('../utils/adminAudit');
const { createNotification } = require('../utils/notifications');
const { sendInvitation } = require('../utils/invite');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const actorEmail = async (db, id) => (await db.query('SELECT email FROM users WHERE id = $1', [id])).rows[0]?.email || null;

const loadDepartments = async (db) => {
  const rows = (await db.query('SELECT code, name, is_active FROM departments')).rows;
  const lookup = new Map();
  for (const d of rows) { lookup.set(d.code.toLowerCase(), d); lookup.set(d.name.toLowerCase(), d); }
  return lookup;
};

// Turns the request's scope into { all, departments[] } with canonical department names, or an error string.
async function parseScope(db, scope) {
  if (scope && scope.all === true) return { value: { all: true, departments: [] } };
  if (!scope || !Array.isArray(scope.departments)) return { error: 'scope must be { all: true } or { departments: [...] }' };
  const lookup = await loadDepartments(db);
  const names = [];
  for (const raw of scope.departments) {
    const d = lookup.get(String(raw).trim().toLowerCase());
    if (!d) return { error: `Unknown department "${raw}"` };
    if (!d.is_active) return { error: `Department "${raw}" is inactive` };
    names.push(d.name);
  }
  return { value: { all: false, departments: [...new Set(names)] } };
}

const FACULTY_SELECT = `id, name, email, department, employee_id, designation, status, invited_at, created_at`;

async function shape(db, row) {
  return { ...row, scope: await getScope(db, row.id) };
}

/** GET /admin/faculty?search=&department=&account_status=&page=&limit= */
router.get('/faculty', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const params = [];
    let where = `role = 'faculty'`;
    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      where += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR employee_id ILIKE $${params.length})`;
    }
    if (req.query.department) { params.push(String(req.query.department)); where += ` AND department = $${params.length}`; }
    if (['INVITED', 'ACTIVE', 'SUSPENDED'].includes(req.query.account_status)) { params.push(req.query.account_status); where += ` AND status = $${params.length}`; }

    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE ${where}`, params)).rows[0].n;
    const rows = (await pool.query(
      `SELECT ${FACULTY_SELECT} FROM users WHERE ${where} ORDER BY name LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params)).rows;
    const faculty = [];
    for (const r of rows) faculty.push(await shape(pool, r));
    res.json({ faculty, total, page, limit });
  } catch (err) {
    console.error('Faculty list error:', err);
    res.status(500).json({ error: 'Could not load faculty' });
  }
});

router.get('/faculty/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid faculty ID' });
  const r = (await pool.query(`SELECT ${FACULTY_SELECT} FROM users WHERE id = $1 AND role = 'faculty'`, [id])).rows[0];
  if (!r) return res.status(404).json({ error: 'Faculty member not found' });
  res.json({ faculty: await shape(pool, r) });
});

/** POST /admin/faculty - creates an INVITED faculty account (no password is ever set by an admin). */
router.post('/faculty', async (req, res) => {
  const client = await pool.connect();
  let created;
  try {
    const deptLookup = await loadDepartments(client);
    const v = validateFacultyRow(req.body || {}, { deptLookup });
    if (v.errors.length) return res.status(400).json({ error: v.errors.join('; '), details: v.errors });

    let scope = { all: false, departments: [v.value.department] };
    if (req.body.scope !== undefined) {
      const p = await parseScope(client, req.body.scope);
      if (p.error) return res.status(400).json({ error: p.error });
      scope = p.value;
    }

    await client.query('BEGIN');
    const dup = (await client.query(
      `SELECT 1 FROM users WHERE LOWER(email) = $1 OR UPPER(employee_id) = $2`, [v.value.email, v.value.faculty_id])).rows[0];
    if (dup) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'A user with this email or faculty ID already exists' }); }

    created = (await client.query(
      `INSERT INTO users (name, email, role, status, is_active, employee_id, department, designation, invited_at)
       VALUES ($1, $2, 'faculty', 'INVITED', FALSE, $3, $4, NULLIF($5, ''), NOW())
       RETURNING ${FACULTY_SELECT}`,
      [v.value.name, v.value.email, v.value.faculty_id, v.value.department, v.value.designation || ''])).rows[0];
    await setScope(client, created.id, scope, req.user.id);
    await logAdminAudit(client, {
      actorId: req.user.id, actorLabel: await actorEmail(client, req.user.id), action: 'FACULTY_CREATED',
      targetType: 'user', targetId: created.id, details: { employee_id: created.employee_id, department: created.department, scope },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this email or faculty ID already exists' });
    console.error('Create faculty error:', err);
    return res.status(500).json({ error: 'Could not create the faculty account' });
  } finally {
    client.release();
  }

  let invitation = { mode: 'NONE', note: 'Email delivery is not configured, so no email was sent. Use "Activation link" to hand the link to the faculty member.' };
  try {
    const r = await sendInvitation(pool, created.id, req.user.id);
    if (r.sent) invitation = { mode: 'EMAIL', note: 'An invitation email was sent.' };
    else if (r.reason === 'SEND_FAILED') invitation = { mode: 'NONE', note: 'The invitation email could not be sent. Use "Activation link" instead.' };
  } catch (e) { console.error('Invitation failed:', e.message); }
  res.status(201).json({ faculty: await shape(pool, created), invitation });
});

/** PUT /admin/faculty/:id - name, department, designation, faculty ID. Email is the login identity and is not editable here. */
router.put('/faculty/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid faculty ID' });
    const cur = (await pool.query(`SELECT ${FACULTY_SELECT} FROM users WHERE id = $1 AND role = 'faculty'`, [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Faculty member not found' });

    const body = req.body || {};
    const deptLookup = await loadDepartments(pool);
    const v = validateFacultyRow({
      faculty_id: body.employee_id ?? body.faculty_id ?? cur.employee_id,
      name: body.name ?? cur.name,
      email: cur.email,
      department: body.department ?? cur.department,
      designation: body.designation ?? cur.designation ?? '',
    }, { deptLookup });
    if (v.errors.length) return res.status(400).json({ error: v.errors.join('; '), details: v.errors });

    const next = v.value;
    const changed = {};
    if (next.name !== cur.name) changed.name = [cur.name, next.name];
    if (next.department !== cur.department) changed.department = [cur.department, next.department];
    if (next.faculty_id !== (cur.employee_id || '').toUpperCase()) changed.employee_id = [cur.employee_id, next.faculty_id];
    if ((next.designation || '') !== (cur.designation || '')) changed.designation = [cur.designation, next.designation];
    if (!Object.keys(changed).length) return res.json({ faculty: await shape(pool, cur), changed: [] });

    await pool.query(
      `UPDATE users SET name = $2, department = $3, employee_id = $4, designation = NULLIF($5, '') WHERE id = $1`,
      [id, next.name, next.department, next.faculty_id, next.designation || '']);
    await logAdminAudit(pool, {
      actorId: req.user.id, actorLabel: await actorEmail(pool, req.user.id), action: 'FACULTY_UPDATED',
      targetType: 'user', targetId: id, details: { changed: Object.keys(changed) },
    });
    const fresh = (await pool.query(`SELECT ${FACULTY_SELECT} FROM users WHERE id = $1`, [id])).rows[0];
    res.json({ faculty: await shape(pool, fresh), changed: Object.keys(changed) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another user already has this faculty ID' });
    console.error('Update faculty error:', err);
    res.status(500).json({ error: 'Could not update the faculty account' });
  }
});

/** PUT /admin/faculty/:id/scope   body: { all: true } | { departments: [code|name, ...] } (empty = no access) */
router.put('/faculty/:id/scope', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid faculty ID' });
    const p = await parseScope(client, req.body);
    if (p.error) return res.status(400).json({ error: p.error });

    await client.query('BEGIN');
    const f = (await client.query(`SELECT id FROM users WHERE id = $1 AND role = 'faculty' FOR UPDATE`, [id])).rows[0];
    if (!f) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Faculty member not found' }); }
    const before = await getScope(client, id);
    await setScope(client, id, p.value, req.user.id);
    await logAdminAudit(client, {
      actorId: req.user.id, actorLabel: await actorEmail(client, req.user.id), action: 'FACULTY_SCOPE_CHANGED',
      targetType: 'user', targetId: id, details: { from: before, to: p.value },
    });
    await createNotification(client, {
      userId: id, title: 'Verification Scope Updated',
      message: p.value.all ? 'You can now verify activities from all departments.'
        : p.value.departments.length ? `You can now verify activities from: ${p.value.departments.join(', ')}.`
          : 'You currently have no verification scope. Contact an administrator.',
      type: 'info',
    });
    await client.query('COMMIT');
    res.json({ scope: await getScope(pool, id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Scope update error:', err);
    res.status(500).json({ error: 'Could not update the verification scope' });
  } finally {
    client.release();
  }
});

// ---------------- Administrators (Super Admin only) ----------------
const adminsOnly = [requireSuperAdmin];

router.get('/administrators', adminsOnly, async (_req, res) => {
  const r = await pool.query(
    `SELECT id, name, email, status, is_super_admin, invited_at, created_at FROM users WHERE role = 'admin' ORDER BY is_super_admin DESC, name`);
  res.json({ administrators: r.rows });
});

/** POST /admin/administrators { name, email, super? } creates an INVITED administrator (activation link via the usual route). */
router.post('/administrators', adminsOnly, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Name must be 2-100 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    const isSuper = req.body.super === true;
    const r = await pool.query(
      `INSERT INTO users (name, email, role, status, is_active, is_super_admin, invited_at)
       VALUES ($1, $2, 'admin', 'INVITED', FALSE, $3, NOW()) RETURNING id, name, email, status, is_super_admin`,
      [name, email, isSuper]);
    await logAdminAudit(pool, {
      actorId: req.user.id, actorLabel: await actorEmail(pool, req.user.id), action: 'ADMINISTRATOR_CREATED',
      targetType: 'user', targetId: r.rows[0].id, details: { super: isSuper },
    });
    res.status(201).json({ administrator: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this email already exists' });
    console.error('Create administrator error:', err);
    res.status(500).json({ error: 'Could not create the administrator' });
  }
});

/** PATCH /admin/administrators/:id/super { super: boolean } */
router.patch('/administrators/:id/super', adminsOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });
    if (typeof req.body.super !== 'boolean') return res.status(400).json({ error: 'super must be true or false' });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own Super Admin status' });

    await client.query('BEGIN');
    const t = (await client.query(`SELECT id, role, status, is_super_admin FROM users WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!t || t.role !== 'admin') { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Administrator not found' }); }
    if (t.is_super_admin === req.body.super) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No change: the account already has this setting' }); }
    if (!req.body.super && t.status === 'ACTIVE') {
      // Never leave the platform without an active Super Admin (the caller is one, but be explicit).
      const others = (await client.query(
        `SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_super_admin AND status = 'ACTIVE' AND id <> $1`, [id])).rows[0].n;
      if (others === 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'At least one active Super Admin must remain' }); }
    }
    await client.query('UPDATE users SET is_super_admin = $2 WHERE id = $1', [id, req.body.super]);
    await logAdminAudit(client, {
      actorId: req.user.id, actorLabel: await actorEmail(client, req.user.id),
      action: req.body.super ? 'SUPER_ADMIN_GRANTED' : 'SUPER_ADMIN_REVOKED', targetType: 'user', targetId: id,
    });
    await client.query('COMMIT');
    res.json({ success: true, is_super_admin: req.body.super });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Super admin change error:', err);
    res.status(500).json({ error: 'Could not change Super Admin status' });
  } finally {
    client.release();
  }
});

module.exports = router;
