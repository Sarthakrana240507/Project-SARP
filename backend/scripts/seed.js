require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const pool = require('../src/config/db');
const { initSchema } = require('../src/models/schema');
const { hashFile } = require('../src/utils/hash');
const { setScope } = require('../src/utils/scope');

// Demo accounts have publicly known passwords, so they must never be created on a production server by accident.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
  console.error('Refusing to seed demo accounts in production (they have publicly known passwords).');
  console.error('Create the first administrator with: npm run admin:create -- --email you@example.com --name "Your Name"');
  process.exit(1);
}

/**
 * Generates a clean sample demonstration certificate PDF file.
 */
function createDemoCertificatePdf(filePath, title, recipient, dateStr) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Certificate border
      doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).lineWidth(2).strokeColor('#0f1f3d').stroke();
      doc.rect(26, 26, doc.page.width - 52, doc.page.height - 52).lineWidth(1).strokeColor('#94a3b8').stroke();

      doc.moveDown(2);
      doc.fontSize(14).font('Helvetica').fillColor('#64748b').text('SARP DEMONSTRATION RECORD', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(26).font('Helvetica-Bold').fillColor('#0f1f3d').text('Certificate of Achievement', { align: 'center' });
      doc.moveDown(1);
      doc.fontSize(12).font('Helvetica').fillColor('#475569').text('This is an authentic sample evidence document for SARP platform demonstration, awarded to:', { align: 'center' });
      doc.moveDown(0.8);
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#1e293b').text(recipient, { align: 'center' });
      doc.moveDown(0.8);
      doc.fontSize(14).font('Helvetica').fillColor('#334155').text(`for successful participation and excellence in:`, { align: 'center' });
      doc.moveDown(0.4);
      doc.fontSize(18).font('Helvetica-Bold').fillColor('#2563eb').text(title, { align: 'center' });
      doc.moveDown(1.5);
      doc.fontSize(10).font('Helvetica').fillColor('#64748b').text(`Awarded on ${dateStr} · Verified SARP Demonstration Proof`, { align: 'center' });

      doc.end();
      stream.on('finish', () => resolve(filePath));
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

(async () => {
  // 1. Safety check: never run in production
  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: Demo seeding is strictly disabled in production environments.');
    process.exit(1);
  }

  console.log('Starting safe demonstration data setup...');

  try {
    await initSchema();

    const uploadDir = path.resolve(__dirname, '../uploads');
    fs.mkdirSync(uploadDir, { recursive: true });

    // 2. Demo accounts configuration (non-sensitive local demo passwords)
    const demoAccounts = [
      {
        name: 'SARP Admin',
        email: 'admin@sarp.local',
        password: 'Admin@12345',
        role: 'admin',
        department: 'Computer Science & Engineering',
      },
      {
        name: 'Demo Faculty',
        email: 'faculty@sarp.local',
        password: 'Faculty@12345',
        role: 'faculty',
        department: 'Computer Science & Engineering',
      },
      {
        name: 'Dr. Reviewer',
        email: 'reviewer@sarp.local',
        password: 'Faculty@12345',
        role: 'faculty',
        department: 'Electronics & Communication',
      },
      {
        name: 'Demo Student',
        email: 'student@sarp.local',
        password: 'Student@12345',
        role: 'student',
        department: 'Computer Science & Engineering',
      },
    ];

    // 3. Create demo accounts ONLY if absent — NEVER overwrite existing credentials!
    const accountIds = {};
    for (const acc of demoAccounts) {
      const existing = await pool.query('SELECT id, role FROM users WHERE LOWER(email) = LOWER($1)', [acc.email]);
      if (existing.rows.length > 0) {
        accountIds[acc.email] = existing.rows[0].id;
        console.log(`[PASS] Demo account ${acc.email} already exists (ID: ${existing.rows[0].id}). Preserving credentials.`);
      } else {
        const hash = await bcrypt.hash(acc.password, 12);
        const insert = await pool.query(
          `INSERT INTO users (name, email, password_hash, role, department)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [acc.name, acc.email, hash, acc.role, acc.department]
        );
        accountIds[acc.email] = insert.rows[0].id;
        console.log(`[CREATED] Demo account ${acc.email} initialized (ID: ${insert.rows[0].id}).`);
      }
    }

    const demoStudentId = accountIds['student@sarp.local'];
    const demoFacultyId = accountIds['faculty@sarp.local'];

    // Demo administrator is a Super Admin; demo faculty get an explicit verification scope.
    await pool.query(`UPDATE users SET is_super_admin = TRUE WHERE email = 'admin@sarp.local' AND role = 'admin'`);
    await setScope(pool, demoFacultyId, { all: true, departments: [] }, null);
    if (accountIds['reviewer@sarp.local']) {
      await setScope(pool, accountIds['reviewer@sarp.local'], { all: false, departments: ['Electronics & Communication'] }, null);
    }

    // 4. Ensure demo proof files exist on disk with valid PDF structure & real SHA-256
    const samplePdfs = [
      {
        fileName: 'demo-sih-certificate.pdf',
        title: 'Smart India Hackathon Demonstration',
        recipient: 'Demo Student',
        date: 'October 15, 2026',
      },
      {
        fileName: 'demo-cloud-workshop.pdf',
        title: 'Cloud Computing & DevOps Workshop',
        recipient: 'Demo Student',
        date: 'November 2, 2026',
      },
      {
        fileName: 'demo-sports-meet.pdf',
        title: 'Inter-College Athletics Championship',
        recipient: 'Demo Student',
        date: 'September 20, 2026',
      },
    ];

    const fileMap = {};
    for (const item of samplePdfs) {
      const filePath = path.join(uploadDir, item.fileName);
      if (!fs.existsSync(filePath)) {
        await createDemoCertificatePdf(filePath, item.title, item.recipient, item.date);
        console.log(`[CREATED] Sample demonstration proof: ${item.fileName}`);
      }
      const stat = fs.statSync(filePath);
      const hash = await hashFile(filePath);
      fileMap[item.fileName] = {
        path: filePath,
        size: stat.size,
        hash,
        mime: 'application/pdf',
      };
    }

    // 5. Check if demo activities already exist for Demo Student
    const existingActivities = await pool.query(
      'SELECT id, title, proof_file_path FROM activities WHERE student_id = $1',
      [demoStudentId]
    );

    if (existingActivities.rows.length === 0) {
      console.log('Seeding demonstration activity records with genuine proof documents...');

      // Record 1: Approved Hackathon
      const f1 = fileMap['demo-sih-certificate.pdf'];
      const r1 = await pool.query(
        `INSERT INTO activities (
          student_id, title, category, description,
          proof_file_path, proof_original_name, proof_mime_type, proof_size,
          file_hash, is_duplicate, status, reviewer_id, review_remarks, reviewed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() - INTERVAL '3 days')
        RETURNING id`,
        [
          demoStudentId,
          'Smart India Hackathon Finalist',
          'hackathon',
          'Demonstration submission: Represented university at the national level finals.',
          f1.path,
          'demo-sih-certificate.pdf',
          f1.mime,
          f1.size,
          f1.hash,
          false,
          'approved',
          demoFacultyId,
          'Authentic certificate verified against event registry. Excellent achievement.',
        ]
      );
      await pool.query(
        `INSERT INTO audit_log (activity_id, student_id, reviewer_id, old_status, new_status, remarks, created_at)
         VALUES ($1, $2, NULL, 'none', 'pending', 'Submitted for verification', NOW() - INTERVAL '5 days'),
                ($1, $2, $3, 'pending', 'approved', 'Authentic certificate verified against event registry. Excellent achievement.', NOW() - INTERVAL '3 days')`,
        [r1.rows[0].id, demoStudentId, demoFacultyId]
      );

      // Record 2: Pending Workshop
      const f2 = fileMap['demo-cloud-workshop.pdf'];
      const r2 = await pool.query(
        `INSERT INTO activities (
          student_id, title, category, description,
          proof_file_path, proof_original_name, proof_mime_type, proof_size,
          file_hash, is_duplicate, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
        RETURNING id`,
        [
          demoStudentId,
          'Cloud Computing & DevOps Workshop',
          'workshop',
          'Demonstration submission: Hands-on 32-hour technical training on cloud architecture.',
          f2.path,
          'demo-cloud-workshop.pdf',
          f2.mime,
          f2.size,
          f2.hash,
          false,
        ]
      );
      await pool.query(
        `INSERT INTO audit_log (activity_id, student_id, reviewer_id, old_status, new_status, remarks, created_at)
         VALUES ($1, $2, NULL, 'none', 'pending', 'Submitted for verification', NOW() - INTERVAL '1 day')`,
        [r2.rows[0].id, demoStudentId]
      );

      // Record 3: Approved Sports
      const f3 = fileMap['demo-sports-meet.pdf'];
      const r3 = await pool.query(
        `INSERT INTO activities (
          student_id, title, category, description,
          proof_file_path, proof_original_name, proof_mime_type, proof_size,
          file_hash, is_duplicate, status, reviewer_id, review_remarks, reviewed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() - INTERVAL '7 days')
        RETURNING id`,
        [
          demoStudentId,
          'Inter-College Athletics Championship',
          'sports',
          'Demonstration submission: 2nd Place in Men 400m Track and Field Event.',
          f3.path,
          'demo-sports-meet.pdf',
          f3.mime,
          f3.size,
          f3.hash,
          false,
          'approved',
          demoFacultyId,
          'Sports committee official certificate verified.',
        ]
      );
      await pool.query(
        `INSERT INTO audit_log (activity_id, student_id, reviewer_id, old_status, new_status, remarks, created_at)
         VALUES ($1, $2, NULL, 'none', 'pending', 'Submitted for verification', NOW() - INTERVAL '10 days'),
                ($1, $2, $3, 'pending', 'approved', 'Sports committee official certificate verified.', NOW() - INTERVAL '7 days')`,
        [r3.rows[0].id, demoStudentId, demoFacultyId]
      );

      console.log('[SUCCESS] Demonstration activities and audit log created.');
    } else {
      console.log(`[PASS] Demo Student already has ${existingActivities.rows.length} activities. Ensuring proof files are linked...`);
      // Ensure any existing demo records that had null proof files get linked to valid files
      for (const row of existingActivities.rows) {
        if (!row.proof_file_path || !fs.existsSync(row.proof_file_path)) {
          let chosenKey = 'demo-sih-certificate.pdf';
          if (row.title.toLowerCase().includes('workshop')) chosenKey = 'demo-cloud-workshop.pdf';
          if (row.title.toLowerCase().includes('sports')) chosenKey = 'demo-sports-meet.pdf';
          const fileInfo = fileMap[chosenKey];
          await pool.query(
            `UPDATE activities
             SET proof_file_path = $1, proof_original_name = $2, proof_mime_type = $3, proof_size = $4, file_hash = $5
             WHERE id = $6`,
            [fileInfo.path, chosenKey, fileInfo.mime, fileInfo.size, fileInfo.hash, row.id]
          );
          console.log(`[LINKED] Linked sample evidence to existing activity #${row.id} (${row.title})`);
        }
      }
    }

    console.log('\n======================================================');
    console.log('SARP DEMONSTRATION SETUP COMPLETE (SAFE MODE)');
    console.log('======================================================');
    console.log('Student account:  student@sarp.local   / Student@12345');
    console.log('Faculty account:  faculty@sarp.local   / Faculty@12345');
    console.log('Reviewer account: reviewer@sarp.local  / Faculty@12345');
    console.log('Admin account:    admin@sarp.local     / Admin@12345');
    console.log('======================================================\n');
  } catch (err) {
    console.error('Seed execution error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
