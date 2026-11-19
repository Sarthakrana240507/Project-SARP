// PDF reports (PDFKit). Pure rendering: it only draws the numbers it is given, and prints the active filters
// on the first page so a printed report says exactly which records it covers.
const PDFDocument = require('pdfkit');

const C = { text: '#27333A', muted: '#75818A', accent: '#477A75', blue: '#657A9C', soft: '#E8F1EE', line: '#E3E9E6', warn: '#B45309', bad: '#B91C1C' };
const TITLES = { institutional: 'Institutional Activity Report', department: 'Department-wise Report', semester: 'Semester-wise Report' };
const L = 48; const W = 516;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%');

function ensure(doc, h) { if (doc.y + h > doc.page.height - 64) doc.addPage(); }
function heading(doc, text) { ensure(doc, 50); doc.moveDown(0.8); doc.font('Helvetica-Bold').fontSize(12).fillColor(C.text).text(text, L, doc.y); doc.moveDown(0.4); }

/** columns: [{ label, width, align }]; rows: arrays of strings/numbers. Repeats its header on a new page. */
function table(doc, columns, rows, empty = 'No records for the selected filters.') {
  if (!rows.length) { doc.font('Helvetica').fontSize(10).fillColor(C.muted).text(empty, L, doc.y); return; }
  const header = () => {
    const y = doc.y;
    doc.rect(L, y, W, 20).fill(C.soft);
    let x = L;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.text);
    for (const c of columns) { doc.text(c.label, x + 3, y + 6, { width: c.width - 6, align: c.align || 'left', lineBreak: false }); x += c.width; }
    doc.y = y + 20;
  };
  ensure(doc, 60); header();
  for (const r of rows) {
    if (doc.y + 20 > doc.page.height - 64) { doc.addPage(); header(); }
    const y = doc.y; let x = L;
    doc.font('Helvetica').fontSize(9).fillColor(C.text);
    columns.forEach((c, i) => { doc.text(String(r[i] ?? ''), x + 3, y + 5, { width: c.width - 6, align: c.align || 'left', lineBreak: false, ellipsis: true }); x += c.width; });
    doc.moveTo(L, y + 19).lineTo(L + W, y + 19).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.y = y + 20;
  }
}

const metricCols = (first, firstWidth) => {
  const w = Math.floor((W - firstWidth) / 7);
  return [{ label: first, width: firstWidth }, ...['Students', 'Submitted', 'Approved', 'Pending', 'Rejected', 'Correction'].map((l) => ({ label: l, width: w, align: 'right' })), { label: 'Approved %', width: W - firstWidth - w * 6, align: 'right' }];
};
const metricRow = (name, r) => [name, r.students, r.total, r.approved, r.pending, r.rejected, r.correction_requested, pct(r.approved, r.total)];

function buildReportPdf({ report, data, breakdown, filters, scope }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, bufferPages: true, info: { Title: TITLES[report], Author: 'SARP' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const t = data.totals;

    doc.font('Helvetica').fontSize(9).fillColor(C.muted).text('SARP · STUDENT ACTIVITY RECORDS PLATFORM', L, 48);
    doc.moveDown(0.4).font('Helvetica-Bold').fontSize(21).fillColor(C.text).text(TITLES[report]);
    doc.moveDown(0.3).font('Helvetica').fontSize(9).fillColor(C.muted)
      .text(`Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · ${scope} · drafts are never included`);

    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.text).text('Filters applied');
    doc.font('Helvetica').fontSize(9.5).fillColor(C.text).text(filters.length ? filters.join('  ·  ') : 'None (all records in scope)', { width: W });

    doc.moveDown(0.8);
    const y = doc.y; doc.roundedRect(L, y, W, 62, 6).fillAndStroke('#F4F6F5', C.line);
    [['Submissions', t.total_activities, C.text], ['Approved', t.approved, C.accent], ['Pending', t.pending, C.warn], ['Rejected', t.rejected, C.bad], ['Students', t.total_students, C.blue]]
      .forEach(([label, v, col], i) => {
        const x = L + 16 + i * 100;
        doc.font('Helvetica-Bold').fontSize(18).fillColor(col).text(String(v), x, y + 12, { lineBreak: false });
        doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(label, x, y + 38, { lineBreak: false });
      });
    doc.y = y + 70;

    if (t.total_activities === 0) {
      heading(doc, 'No data');
      doc.font('Helvetica').fontSize(10).fillColor(C.muted).text('No submissions match the selected filters, so there is nothing to report.', L, doc.y);
    } else if (report === 'institutional') {
      heading(doc, 'Status distribution');
      table(doc, [{ label: 'Status', width: 316 }, { label: 'Records', width: 100, align: 'right' }, { label: 'Share', width: 100, align: 'right' }],
        data.by_status.map((s) => [s.status.replace(/_/g, ' '), s.count, pct(s.count, t.total_activities)]));
      heading(doc, 'Category distribution');
      table(doc, [{ label: 'Category', width: 316 }, { label: 'Records', width: 100, align: 'right' }, { label: 'Share', width: 100, align: 'right' }],
        data.by_category.map((c) => [c.category, c.count, pct(c.count, t.total_activities)]));
      heading(doc, 'Department participation');
      table(doc, metricCols('Department', 110), data.by_department.map((r) => metricRow(r.department, r)));
      heading(doc, 'Semester-wise');
      table(doc, metricCols('Semester', 110), data.by_semester.map((r) => metricRow(`Semester ${r.semester}`, r)), 'No semester recorded for these submissions.');
      heading(doc, 'Academic year comparison');
      table(doc, metricCols('Academic year', 110), data.by_academic_year.map((r) => metricRow(r.academic_session, r)), 'No academic year recorded for these submissions.');
      heading(doc, 'Integrity');
      doc.font('Helvetica').fontSize(10).fillColor(C.text).text(`Submissions flagged as sharing a SHA-256 proof hash with an earlier one: ${data.flagged_duplicates}`, L, doc.y);
      doc.text(`Corrections requested: ${t.correction_requested}`);
    } else {
      const rows = report === 'department' ? data.by_department.map((r) => metricRow(r.department, r)) : data.by_semester.map((r) => metricRow(`Semester ${r.semester}`, r));
      heading(doc, report === 'department' ? 'Participation by department' : 'Participation by semester');
      table(doc, metricCols(report === 'department' ? 'Department' : 'Semester', 110), rows);
      heading(doc, 'Category breakdown');
      const groups = [...new Set(breakdown.map((b) => b.group))];
      for (const g of groups) {
        ensure(doc, 60);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.accent).text(g, L, doc.y); doc.moveDown(0.3);
        const total = breakdown.filter((b) => b.group === g).reduce((a, b) => a + b.count, 0);
        table(doc, [{ label: 'Category', width: 316 }, { label: 'Records', width: 100, align: 'right' }, { label: 'Share', width: 100, align: 'right' }],
          breakdown.filter((b) => b.group === g).map((b) => [b.category, b.count, pct(b.count, total)]));
        doc.moveDown(0.6);
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // writing inside the bottom margin would otherwise make PDFKit add an empty page
      doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(`SARP · ${TITLES[report]} · Page ${i + 1} of ${range.count}`, L, doc.page.height - 36, { width: W, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { buildReportPdf };
