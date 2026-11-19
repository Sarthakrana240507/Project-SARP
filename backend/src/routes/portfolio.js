const express = require('express');
const PDFDocument = require('pdfkit');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { canAccessStudent } = require('../utils/scope');

const router = express.Router();

/**
 * Returns JSON representation of a student's verified portfolio.
 */
router.get('/:studentId/data', requireAuth, async (req, res) => {
  try {
    const studentId = Number(req.params.studentId);
    if (!Number.isInteger(studentId) || studentId < 1) {
      return res.status(400).json({ error: 'Invalid student id' });
    }
    if (!(await canAccessStudent(pool, req.user, studentId))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const studentResult = await pool.query(
      'SELECT id, name, email, department FROM users WHERE id = $1',
      [studentId]
    );
    const student = studentResult.rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const activitiesResult = await pool.query(
      `SELECT activities.*, reviewer.name AS reviewer_name
       FROM activities
       LEFT JOIN users reviewer ON reviewer.id = activities.reviewer_id
       WHERE activities.student_id = $1 AND activities.status = 'approved'
       ORDER BY activities.reviewed_at DESC, activities.created_at DESC`,
      [studentId]
    );

    res.json({
      student,
      activities: activitiesResult.rows,
      count: activitiesResult.rows.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve portfolio data' });
  }
});

/**
 * Generates and streams a formal PDF document of the verified portfolio.
 */
router.get('/:studentId', requireAuth, async (req, res) => {
  try {
    const studentId = Number(req.params.studentId);
    if (!Number.isInteger(studentId) || studentId < 1) {
      return res.status(400).json({ error: 'Invalid student id' });
    }
    if (!(await canAccessStudent(pool, req.user, studentId))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const studentR = await pool.query(
      'SELECT id, name, email, department FROM users WHERE id = $1',
      [studentId]
    );
    const student = studentR.rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const activitiesR = await pool.query(
      `SELECT activities.*, reviewer.name AS reviewer_name
       FROM activities
       LEFT JOIN users reviewer ON reviewer.id = activities.reviewer_id
       WHERE activities.student_id = $1 AND activities.status = 'approved'
       ORDER BY activities.reviewed_at DESC, activities.created_at DESC`,
      [studentId]
    );
    const activities = activitiesR.rows;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${student.name.replace(/[^a-z0-9]+/gi, '_')}_SARP_Portfolio.pdf"`
    );

    const doc = new PDFDocument({ margin: 52, bufferPages: true });
    doc.pipe(res);

    // Header section
    doc.fontSize(10).fillColor('#64748b').text('SARP · STUDENT ACTIVITY RECORD PLATFORM');
    doc.moveDown(0.8);
    doc.fillColor('#0f1f3d').fontSize(24).font('Helvetica-Bold').text('Verified Activity Portfolio');
    doc.moveDown(0.4);
    doc.fillColor('#172033').fontSize(14).font('Helvetica-Bold').text(student.name);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#64748b')
      .text(`${student.department || 'Department not set'} · ${student.email}`);
    doc.moveDown(1.3);

    // Summary box
    doc.fillColor('#172033').fontSize(11).font('Helvetica-Bold').text('VERIFIED ACHIEVEMENT SUMMARY');
    doc.moveDown(0.35);
    doc.font('Helvetica').fontSize(10).text(`Total verified activities: ${activities.length}`);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);
    doc.moveDown(1);
    doc
      .fillColor('#64748b')
      .fontSize(8)
      .text(
        'All activities listed below have been verified and approved through the official SARP faculty review workflow. Cryptographic SHA-256 digests identify identical proof submissions across the institution.'
      );
    doc.fillColor('#172033');

    if (!activities.length) {
      doc.moveDown(2);
      doc.fontSize(11).font('Helvetica').fillColor('#64748b').text('No verified activities on record yet.');
    }

    // List of activities
    activities.forEach((a, i) => {
      if (i > 0) doc.moveDown(1);
      doc.moveTo(52, doc.y).lineTo(543, doc.y).strokeColor('#e2e8f0').stroke();
      doc.moveDown(0.6);

      doc
        .font('Helvetica-Bold')
        .fontSize(13)
        .fillColor('#0f1f3d')
        .text(`${String(i + 1).padStart(2, '0')}  ${a.title}`);

      const verifiedDate = a.reviewed_at ? new Date(a.reviewed_at).toLocaleDateString() : 'Verified';
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#64748b')
        .text(
          `${a.category.toUpperCase()} · Verified on ${verifiedDate}${
            a.reviewer_name ? ` by ${a.reviewer_name}` : ''
          }`
        );

      if (a.description) {
        doc.moveDown(0.4);
        doc.fontSize(10).fillColor('#334155').text(a.description, { lineGap: 3 });
      }

      doc.moveDown(0.5);
      doc
        .fontSize(8)
        .fillColor('#94a3b8')
        .text(`Record ID: ${a.id}${a.file_hash ? ` · SHA-256 Digest: ${a.file_hash}` : ''}`);
      doc.fillColor('#172033');
    });

    // Page numbering footer on all pages
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor('#94a3b8')
        .text(`SARP · Student Activity Records Platform · Verified Official Document`, 52, doc.page.height - 38, {
          width: 350,
        });
      doc.text(`Page ${i + 1} of ${range.count}`, 443, doc.page.height - 38, { width: 50, align: 'right' });
    }

    doc.end();
  } catch (err) {
    console.error('PDF generation error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate portfolio PDF' });
    }
  }
});

module.exports = router;
