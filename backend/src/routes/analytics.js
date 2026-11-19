const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { scopeFragment, getScope } = require('../utils/scope');
const { parseFilters, buildWhere, describe, SEM } = require('../utils/analyticsFilters');
const { csvCell } = require('../utils/csvSafe');
const { buildReportPdf } = require('../utils/reportPdf');

// Every number here is computed from PostgreSQL for the filters in the request. Faculty are always limited to their
// verification scope (see buildWhere), so a faculty member's charts, CSV and PDF never include other departments.
const router = express.Router();
router.use(requireAuth, requireRole('faculty', 'admin'));

const FROM = 'FROM activities JOIN users ON users.id = activities.student_id';
const PARTS = `
  COUNT(*)::int AS total,
  COUNT(*) FILTER (WHERE activities.status = 'approved')::int AS approved,
  COUNT(*) FILTER (WHERE activities.status IN ('pending', 'resubmitted'))::int AS pending,
  COUNT(*) FILTER (WHERE activities.status = 'rejected')::int AS rejected,
  COUNT(*) FILTER (WHERE activities.status = 'correction_requested')::int AS correction_requested,
  COUNT(DISTINCT activities.student_id)::int AS students`;
const DEPT = `COALESCE(users.department, 'Unspecified')`;

function filtersOr400(req, res) {
  const { filters, error } = parseFilters(req.query);
  if (error) { res.status(400).json({ error }); return null; }
  return filters;
}

/** GET /analytics/options - the values the filter controls offer, from the database (never a fixed list). */
router.get('/options', async (req, res) => {
  try {
    const params = [];
    const scoped = scopeFragment(req.user, params, 'users.department');
    const [depts, progs, cats, years, sems] = await Promise.all([
      pool.query(`SELECT DISTINCT department AS v FROM users WHERE role = 'student' AND department IS NOT NULL AND department <> '' ${scoped}
                  ${req.user.role === 'admin' ? `UNION SELECT name FROM departments WHERE is_active` : ''} ORDER BY v`, params),
      pool.query(`SELECT DISTINCT programme AS v FROM users WHERE role = 'student' AND programme IS NOT NULL AND programme <> '' ${scoped}
                  ${req.user.role === 'admin' ? `UNION SELECT name FROM programmes WHERE is_active` : ''} ORDER BY v`, params),
      pool.query(`SELECT name, display_name FROM categories ORDER BY display_name`),
      pool.query(`SELECT DISTINCT academic_session AS v FROM activities WHERE academic_session IS NOT NULL AND academic_session ~ '^[0-9]{4}-[0-9]{4}$' ORDER BY v DESC`),
      pool.query(`SELECT DISTINCT ${SEM} AS v FROM activities WHERE ${SEM} IS NOT NULL ORDER BY v`),
    ]);
    res.json({
      departments: depts.rows.map((r) => r.v), programmes: progs.rows.map((r) => r.v),
      categories: cats.rows, academic_years: years.rows.map((r) => r.v), semesters: sems.rows.map((r) => Number(r.v)),
      statuses: ['approved', 'pending', 'rejected', 'correction_requested'],
      scope: req.user.role === 'faculty' ? await getScope(pool, req.user.id) : null,
    });
  } catch (err) { console.error('Analytics options error:', err.message); res.status(500).json({ error: 'Failed to load filter options' }); }
});

/** Everything the dashboard and the PDF need for one set of filters. */
async function aggregate(filters, user) {
  const { where, params } = buildWhere(filters, user);
  const q = (sql, extra = []) => pool.query(sql, [...params, ...extra]);
  const decided = `${where} AND activities.status IN ('approved','rejected','correction_requested') AND activities.reviewer_id IS NOT NULL`;
  const workloadWhere = user.role === 'faculty' ? `${decided} AND activities.reviewer_id = $${params.length + 1}` : decided;
  const [totals, byStatus, byCategory, byDepartment, bySemester, byYear, byMonth, pendingByMonth, workload, dup] = await Promise.all([
    q(`SELECT ${PARTS} ${FROM} ${where}`),
    q(`SELECT activities.status, COUNT(*)::int AS count ${FROM} ${where} GROUP BY activities.status ORDER BY activities.status`),
    q(`SELECT activities.category, COUNT(*)::int AS count ${FROM} ${where} GROUP BY activities.category ORDER BY count DESC, activities.category`),
    q(`SELECT ${DEPT} AS department, COUNT(*)::int AS count, ${PARTS} ${FROM} ${where} GROUP BY ${DEPT} ORDER BY count DESC, department`),
    q(`SELECT ${SEM} AS semester, ${PARTS} ${FROM} ${where} AND ${SEM} IS NOT NULL GROUP BY 1 ORDER BY 1`),
    q(`SELECT activities.academic_session, ${PARTS} ${FROM} ${where} AND activities.academic_session IS NOT NULL GROUP BY activities.academic_session ORDER BY activities.academic_session`),
    q(`SELECT TO_CHAR(m, 'Mon YYYY') AS month, count, m AS month_date FROM (
         SELECT DATE_TRUNC('month', activities.created_at) AS m, COUNT(*)::int AS count ${FROM} ${where} GROUP BY 1 ORDER BY 1 DESC LIMIT 12) t ORDER BY m`),
    q(`SELECT TO_CHAR(m, 'Mon YYYY') AS month, count FROM (
         SELECT DATE_TRUNC('month', activities.created_at) AS m, COUNT(*)::int AS count ${FROM} ${where} AND activities.status IN ('pending','resubmitted') GROUP BY 1 ORDER BY 1 DESC LIMIT 12) t ORDER BY m`),
    pool.query(`SELECT reviewer.id AS faculty_id, reviewer.name,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE activities.status = 'approved')::int AS approved,
                  COUNT(*) FILTER (WHERE activities.status = 'rejected')::int AS rejected,
                  COUNT(*) FILTER (WHERE activities.status = 'correction_requested')::int AS correction_requested
                 ${FROM} JOIN users reviewer ON reviewer.id = activities.reviewer_id ${workloadWhere}
                GROUP BY reviewer.id, reviewer.name ORDER BY total DESC, reviewer.name`, user.role === 'faculty' ? [...params, user.id] : params),
    q(`SELECT COUNT(*)::int AS count ${FROM} ${where} AND activities.is_duplicate = TRUE`),
  ]);
  const t = totals.rows[0];
  return {
    totals: { total_activities: t.total, total_students: t.students, approved: t.approved, pending: t.pending, rejected: t.rejected, correction_requested: t.correction_requested, drafts: 0 },
    by_status: byStatus.rows, by_category: byCategory.rows, by_department: byDepartment.rows,
    by_semester: bySemester.rows.map((r) => ({ ...r, semester: Number(r.semester) })),
    by_academic_year: byYear.rows, by_month: byMonth.rows, pending_by_month: pendingByMonth.rows,
    faculty_workload: workload.rows, flagged_duplicates: dup.rows[0].count,
  };
}

/** GET /analytics?department=&programme=&category=&status=&academic_session=&semester=&date_from=&date_to= */
router.get('/', async (req, res) => {
  try {
    const filters = filtersOr400(req, res); if (!filters) return;
    res.json({ ...(await aggregate(filters, req.user)), filters });
  } catch (err) { console.error('Analytics computation error:', err.message); res.status(500).json({ error: 'Failed to compute institutional analytics' }); }
});

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');
const stamp = () => new Date().toISOString().slice(0, 10);
const send = (res, type, name, body) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
};

/** GET /analytics/export/csv?report=activities|department|semester  (same filters as the dashboard) */
router.get('/export/csv', async (req, res) => {
  try {
    const filters = filtersOr400(req, res); if (!filters) return;
    const report = req.query.report || 'activities';
    if (!['activities', 'department', 'semester'].includes(report)) return res.status(400).json({ error: 'report must be activities, department or semester' });
    let lines;
    if (report === 'activities') {
      const { where, params } = buildWhere(filters, req.user);
      const r = await pool.query(
        `SELECT activities.id, activities.title, activities.category, users.name AS student_name, users.email AS student_email,
                COALESCE(users.enrollment_no, '') AS enrollment_no, COALESCE(users.department, 'Unspecified') AS department,
                COALESCE(users.programme, '') AS programme, COALESCE(activities.academic_session, '') AS academic_session,
                COALESCE(activities.semester::text, '') AS semester, activities.status, activities.is_duplicate,
                COALESCE(activities.file_hash, '') AS file_hash, reviewer.name AS reviewer_name,
                COALESCE(activities.review_remarks, '') AS review_remarks, activities.created_at, activities.reviewed_at
         ${FROM} LEFT JOIN users reviewer ON reviewer.id = activities.reviewer_id ${where} ORDER BY activities.created_at DESC, activities.id DESC`, params);
      lines = [['Activity ID', 'Title', 'Category', 'Student Name', 'Student Email', 'Enrollment No', 'Department', 'Programme', 'Academic Year', 'Semester', 'Status', 'Duplicate Flag', 'SHA-256 Hash', 'Reviewer Name', 'Review Remarks', 'Submitted At', 'Reviewed At'].join(',')];
      for (const a of r.rows) {
        lines.push([a.id, a.title, a.category, a.student_name, a.student_email, a.enrollment_no, a.department, a.programme, a.academic_session, a.semester, a.status,
          a.is_duplicate ? 'YES' : 'NO', a.file_hash, a.reviewer_name, a.review_remarks, a.created_at ? new Date(a.created_at).toISOString() : '', a.reviewed_at ? new Date(a.reviewed_at).toISOString() : ''].map((v, i) => (i === 0 ? v : csvCell(v))).join(','));
      }
    } else {
      const data = await aggregate(filters, req.user);
      const head = ['Students', 'Submissions', 'Approved', 'Pending', 'Rejected', 'Correction requested', 'Approved share'];
      const metrics = (r) => [r.students, r.total, r.approved, r.pending, r.rejected, r.correction_requested, pct(r.approved, r.total)];
      if (report === 'department') {
        lines = [['Department', ...head].join(',')];
        for (const r of data.by_department) lines.push([r.department, ...metrics(r)].map(csvCell).join(','));
      } else {
        lines = [['Semester', ...head].join(',')];
        for (const r of data.by_semester) lines.push([`Semester ${r.semester}`, ...metrics(r)].map(csvCell).join(','));
      }
    }
    send(res, 'text/csv; charset=utf-8', `SARP_${report}_report_${stamp()}.csv`, `﻿${lines.join('\r\n')}\r\n`);
  } catch (err) { console.error('CSV export error:', err.message); res.status(500).json({ error: 'Failed to export the CSV report' }); }
});

/** GET /analytics/export/pdf?report=institutional|department|semester */
router.get('/export/pdf', async (req, res) => {
  try {
    const filters = filtersOr400(req, res); if (!filters) return;
    const report = req.query.report || 'institutional';
    if (!['institutional', 'department', 'semester'].includes(report)) return res.status(400).json({ error: 'report must be institutional, department or semester' });
    const data = await aggregate(filters, req.user);
    let breakdown = [];
    if (report !== 'institutional') {
      const { where, params } = buildWhere(filters, req.user);
      const key = report === 'department' ? DEPT : SEM;
      const r = await pool.query(`SELECT ${key} AS grp, activities.category, COUNT(*)::int AS count ${FROM} ${where} ${report === 'semester' ? `AND ${SEM} IS NOT NULL` : ''} GROUP BY 1, 2 ORDER BY 1, count DESC`, params);
      breakdown = r.rows.map((x) => ({ group: report === 'semester' ? `Semester ${x.grp}` : x.grp, category: x.category, count: x.count }));
    }
    const pdf = await buildReportPdf({ report, data, breakdown, filters: describe(filters), scope: req.user.role === 'faculty' ? 'Faculty verification scope only' : 'All departments' });
    send(res, 'application/pdf', `SARP_${report}_report_${stamp()}.pdf`, pdf);
  } catch (err) { console.error('PDF export error:', err.message); res.status(500).json({ error: 'Failed to export the PDF report' }); }
});

module.exports = router;
