// Shared validators for student onboarding.

// ---- Password policy (activation, reset, change-password) ----
function passwordProblem(password, { email, studentId } = {}) {
  const p = String(password ?? '');
  if (p.length < 8) return 'Password must be at least 8 characters long';
  if (p.length > 72) return 'Password must be 72 characters or fewer';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Password must contain at least one letter and one number';
  const lower = p.toLowerCase();
  if (email && lower === String(email).toLowerCase()) return 'Password must not be the same as your email';
  if (studentId && lower === String(studentId).toLowerCase()) return 'Password must not be the same as your student ID';
  return null;
}

// ---- Student CSV rows ----
const REQUIRED_COLUMNS = ['student_id', 'name', 'email', 'department', 'programme', 'academic_year', 'semester'];
const EMAIL_RE = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+$/;
const STUDENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,31}$/;

const normHeader = (h) => String(h || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Name comparison used when a student identifies themselves: case/space/punctuation-insensitive.
const normName = (s) => squash(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

// Accepts "2025-26" or "2025-2026" and returns the canonical "2025-2026" (matches academic_sessions names).
function normalizeAcademicYear(v) {
  const m = /^(\d{4})\s*-\s*(\d{2}|\d{4})$/.exec(squash(v));
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2].length === 2 ? Math.floor(start / 100) * 100 + Number(m[2]) : Number(m[2]);
  // handles century rollover e.g. 2099-00 -> 2100
  const endFixed = m[2].length === 2 && end <= start ? end + 100 : end;
  if (endFixed !== start + 1 || start < 2000 || start > 2100) return null;
  return `${start}-${endFixed}`;
}

function allowedDomains() {
  return String(process.env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}

// ---- field checks shared by student and faculty rows ----
const checkName = (name, errors) => {
  if (!name) errors.push('name is missing');
  else if (name.length < 2 || name.length > 100) errors.push('name must be 2-100 characters');
  else if (/^[=+\-@\t]/.test(name)) errors.push('name must not start with = + - or @'); // spreadsheet formula injection
};
const checkEmail = (email, errors) => {
  if (!email) errors.push('email is missing');
  else if (!EMAIL_RE.test(email) || email.length > 254) errors.push('email is not a valid address');
  else {
    const domains = allowedDomains();
    if (domains.length && !domains.includes(email.split('@')[1])) {
      errors.push(`email domain must be one of: ${domains.join(', ')}`);
    }
  }
};
// Accepts a department code or full name; returns the canonical name that is stored.
// "B.Tech", "b tech" and "BTECH" are the same programme.
const programmeKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const resolveProgramme = (input, ctx, errors) => {
  if (!input) { errors.push('programme is missing'); return null; }
  if (input.length > 50 || !/^[A-Za-z0-9][A-Za-z0-9 .&()/-]*$/.test(input)) { errors.push('programme contains invalid characters or is too long'); return null; }
  if (!ctx.programmeLookup) return input; // no programme list supplied (plain unit use)
  const p = ctx.programmeLookup.get(programmeKey(input));
  if (!p) { errors.push(`programme "${input}" is not configured`); return null; }
  if (!p.is_active) { errors.push(`programme "${input}" is inactive`); return null; }
  return p.name; // the canonical spelling is stored
};

const resolveDepartment = (input, ctx, errors) => {
  if (!input) { errors.push('department is missing'); return null; }
  const d = ctx.deptLookup.get(input.toLowerCase());
  if (!d) { errors.push(`department "${input}" does not exist`); return null; }
  if (!d.is_active) { errors.push(`department "${input}" is inactive`); return null; }
  return d.name;
};

/**
 * Validates one CSV row. `ctx.deptLookup` maps lower-cased department code/name -> { name, is_active }.
 * Returns { value, errors }. `value` is the normalised record when errors is empty.
 */
function validateStudentRow(raw, ctx) {
  const errors = [];
  const studentId = squash(raw.student_id).toUpperCase();
  const name = squash(raw.name);
  const email = squash(raw.email).toLowerCase();
  const deptInput = squash(raw.department);
  const programme = squash(raw.programme);
  const yearInput = raw.academic_year;
  const semInput = squash(raw.semester);

  if (!studentId) errors.push('student_id is missing');
  else if (!STUDENT_ID_RE.test(studentId)) errors.push('student_id must be 3-32 characters: letters, digits, . _ / -');

  checkName(name, errors);
  checkEmail(email, errors);
  const department = resolveDepartment(deptInput, ctx, errors);

  const programmeName = resolveProgramme(programme, ctx, errors);

  let academicYear = null;
  if (!squash(yearInput)) errors.push('academic_year is missing');
  else {
    academicYear = normalizeAcademicYear(yearInput);
    if (!academicYear) errors.push('academic_year must look like 2025-26 or 2025-2026');
  }

  let semester = null;
  if (!semInput) errors.push('semester is missing');
  else if (!/^\d{1,2}$/.test(semInput) || Number(semInput) < 1 || Number(semInput) > 12) errors.push('semester must be a whole number from 1 to 12');
  else semester = String(Number(semInput));

  if (errors.length) return { errors, value: null, idValue: studentId, studentId, email };
  return { errors, value: { student_id: studentId, name, email, department, programme: programmeName, academic_year: academicYear, semester }, idValue: studentId, studentId, email };
}

const FACULTY_COLUMNS = ['faculty_id', 'name', 'email', 'department'];
const FACULTY_OPTIONAL_COLUMNS = ['designation'];

function validateDesignation(raw, errors) {
  const designation = squash(raw);
  if (designation && (designation.length > 100 || !/^[A-Za-z][A-Za-z0-9 .,&()/-]*$/.test(designation))) {
    errors.push('designation contains invalid characters or is too long');
  }
  return designation;
}

/** Validates one faculty CSV row (same contract as validateStudentRow). */
function validateFacultyRow(raw, ctx) {
  const errors = [];
  const facultyId = squash(raw.faculty_id).toUpperCase();
  const name = squash(raw.name);
  const email = squash(raw.email).toLowerCase();

  if (!facultyId) errors.push('faculty_id is missing');
  else if (!STUDENT_ID_RE.test(facultyId)) errors.push('faculty_id must be 3-32 characters: letters, digits, . _ / -');
  checkName(name, errors);
  checkEmail(email, errors);
  const department = resolveDepartment(squash(raw.department), ctx, errors);
  const designation = validateDesignation(raw.designation, errors);

  if (errors.length) return { errors, value: null, idValue: facultyId, email };
  return { errors, value: { faculty_id: facultyId, name, email, department, designation }, idValue: facultyId, email };
}

module.exports = {
  validateFacultyRow, FACULTY_COLUMNS, FACULTY_OPTIONAL_COLUMNS, validateDesignation, checkName, checkEmail, resolveDepartment, STUDENT_ID_RE,
  passwordProblem, programmeKey, REQUIRED_COLUMNS, normHeader, normName, validateStudentRow, normalizeAcademicYear, squash, EMAIL_RE,
};
