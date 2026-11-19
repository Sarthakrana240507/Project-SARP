// Migration 001 - baseline schema.
// This is the original schema from models/schema.js, moved here unchanged.
// Every statement is idempotent (IF NOT EXISTS / ON CONFLICT), so on a database
// that already has these tables it changes nothing and is simply recorded as applied.
module.exports = {
  name: '001_baseline',
  async up(db) {
  // 1. Core Users Table
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      department TEXT,
      enrollment_no TEXT,
      academic_year TEXT,
      semester TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 2. Departments Table
  await db.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 3. Academic Sessions Table
  await db.query(`
    CREATE TABLE IF NOT EXISTS academic_sessions (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      current_semester TEXT NOT NULL,
      is_current BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 4. Activity Categories Table
  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 5. Activities Table (supports draft, pending, correction_requested, resubmitted, approved, rejected)
  await db.query(`
    CREATE TABLE IF NOT EXISTS activities (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      proof_file_path TEXT,
      proof_original_name TEXT,
      proof_mime_type TEXT,
      proof_size INTEGER,
      file_hash TEXT,
      is_duplicate BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewer_id INTEGER REFERENCES users(id),
      review_remarks TEXT,
      correction_notes TEXT,
      academic_session TEXT,
      semester TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      reviewed_at TIMESTAMP,
      resubmitted_at TIMESTAMP
    );
  `);

  // 6. Audit Log Table
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES users(id),
      reviewer_id INTEGER REFERENCES users(id),
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      remarks TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 7. Notifications Table
  await db.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      link TEXT,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Safe backward-compatible ALTER statements for existing databases
  const alters = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS enrollment_no TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS academic_year TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS semester TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE activities ADD COLUMN IF NOT EXISTS is_duplicate BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE activities ADD COLUMN IF NOT EXISTS proof_original_name TEXT`,
    `ALTER TABLE activities ADD COLUMN IF NOT EXISTS proof_mime_type TEXT`,
    `ALTER TABLE activities ADD COLUMN IF NOT EXISTS proof_size INTEGER`,
    `ALTER TABLE activities ADD COLUMN IF NOT EXISTS correction_notes TEXT`,
    `ALTER TABLE activities ADD COLUMN IF NOT EXISTS academic_session TEXT`,
    `ALTER TABLE activities ADD COLUMN IF NOT EXISTS semester TEXT`,
    `ALTER TABLE activities ADD COLUMN IF NOT EXISTS resubmitted_at TIMESTAMP`,
  ];
  for (const sql of alters) {
    await db.query(sql);
  }

  // Indexes for high-performance querying and filtering
  await db.query(`CREATE INDEX IF NOT EXISTS idx_activities_student ON activities(student_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_activities_status ON activities(status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_activities_hash ON activities(file_hash)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_activities_session ON activities(academic_session)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_activity ON audit_log(activity_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC)`);

  // Seed default initial categories if empty
  const catCheck = await db.query('SELECT COUNT(*)::int AS count FROM categories');
  if (catCheck.rows[0].count === 0) {
    const defaultCats = [
      ['hackathon', 'Hackathon & Competitions'],
      ['certification', 'Skill & Professional Certifications'],
      ['workshop', 'Technical Workshops & Bootcamps'],
      ['sports', 'Athletics & Sports Meets'],
      ['internship', 'Industry Internships & Training'],
      ['publication', 'Research Papers & Publications'],
      ['volunteering', 'Social Work & Community Volunteering'],
    ];
    for (const [name, display] of defaultCats) {
      await db.query(
        'INSERT INTO categories (name, display_name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
        [name, display]
      );
    }
  }

  // Seed default academic session if empty
  const sessionCheck = await db.query('SELECT COUNT(*)::int AS count FROM academic_sessions');
  if (sessionCheck.rows[0].count === 0) {
    await db.query(
      `INSERT INTO academic_sessions (name, current_semester, is_current)
       VALUES ('2025-2026', 'Semester 8', true)
       ON CONFLICT (name) DO NOTHING`
    );
  }

  // Seed default departments if empty
  const deptCheck = await db.query('SELECT COUNT(*)::int AS count FROM departments');
  if (deptCheck.rows[0].count === 0) {
    const defaultDepts = [
      ['CSE', 'Computer Science & Engineering'],
      ['ECE', 'Electronics & Communication'],
      ['IT', 'Information Technology'],
      ['ME', 'Mechanical Engineering'],
      ['CE', 'Civil Engineering'],
    ];
    for (const [code, name] of defaultDepts) {
      await db.query(
        'INSERT INTO departments (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING',
        [code, name]
      );
    }
  }
  },
};
