// Server-side validation of the activity form (the frontend checks the same rules for convenience,
// but only this code is trusted).
const { squash, normalizeAcademicYear } = require('./validation');

const LIMITS = { titleMin: 3, titleMax: 150, descriptionMax: 2000, remarksMax: 1000 };

const hasControlChars = (s) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s);

// 'YYYY-MM-DD' that is a real calendar day (rejects 2026-02-31).
function validCalendarDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * raw: { title, category, description, activity_date, academic_session, semester }
 * strict = true for anything that is being submitted for review; drafts are allowed to be incomplete,
 * but whatever IS filled in must still be valid.
 * Returns { errors: {field: message}, value: {...normalized} }.
 */
async function validateActivityFields(db, raw, { strict, existingYear = null }) {
  const errors = {};
  const value = {};

  const title = squash(raw.title);
  if (!title) { if (strict) errors.title = 'Title is required.'; value.title = null; }
  else if (hasControlChars(title)) errors.title = 'Title contains invalid characters.';
  else if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax) errors.title = `Title must be ${LIMITS.titleMin}-${LIMITS.titleMax} characters.`;
  else value.title = title;

  const category = squash(raw.category).toLowerCase();
  if (!category) { if (strict) errors.category = 'Choose a category.'; value.category = null; }
  else {
    // The categories table is the single source of truth (admins can deactivate categories).
    const ok = (await db.query('SELECT 1 FROM categories WHERE name = $1 AND is_active = TRUE', [category])).rows.length > 0;
    if (!ok) errors.category = 'This category is not available.'; else value.category = category;
  }

  const description = String(raw.description ?? '').replace(/\r\n/g, '\n').trim();
  if (hasControlChars(description)) errors.description = 'Description contains invalid characters.';
  else if (description.length > LIMITS.descriptionMax) errors.description = `Description must be at most ${LIMITS.descriptionMax} characters.`;
  else value.description = description || null;

  const date = squash(raw.activity_date);
  if (!date) { if (strict) errors.activity_date = 'Activity date is required.'; value.activity_date = null; }
  else if (!validCalendarDate(date)) errors.activity_date = 'Enter the date as YYYY-MM-DD.';
  else {
    // Compared by PostgreSQL so the server's time zone cannot matter; one day of slack covers time zones ahead of the server.
    const r = (await db.query(`SELECT ($1::date > CURRENT_DATE + 1) AS future, ($1::date < DATE '2000-01-01') AS too_old`, [date])).rows[0];
    if (r.future) errors.activity_date = 'Activity date cannot be in the future.';
    else if (r.too_old) errors.activity_date = 'Activity date is too far in the past.';
    else value.activity_date = date;
  }

  const year = squash(raw.academic_session);
  if (!year) { if (strict) errors.academic_session = 'Academic year is required.'; value.academic_session = null; }
  else {
    const norm = normalizeAcademicYear(year);
    if (!norm || Number(norm.slice(0, 4)) > new Date().getFullYear() + 1) errors.academic_session = 'Academic year must look like 2025-2026.';
    else {
      value.academic_session = norm;
      // A closed (archived) academic year takes no NEW submissions. An older record keeps the year it already has.
      if (norm !== existingYear) {
        const closed = await db.query('SELECT 1 FROM academic_sessions WHERE name = $1 AND is_archived', [norm]);
        if (closed.rows.length) errors.academic_session = 'This academic year is closed for new submissions.';
      }
    }
  }

  const sem = squash(raw.semester);
  if (!sem) { if (strict) errors.semester = 'Semester is required.'; value.semester = null; }
  else if (!/^\d{1,2}$/.test(sem) || Number(sem) < 1 || Number(sem) > 12) errors.semester = 'Semester must be a number from 1 to 12.';
  else value.semester = String(Number(sem));

  return { errors, value };
}

// User text for ILIKE: % and _ are literal characters, not wildcards.
const likePattern = (term) => `%${String(term).trim().replace(/[\\%_]/g, '\\$&')}%`;

const problemText = (errors) => Object.values(errors).join(' ');

module.exports = { validateActivityFields, problemText, likePattern, LIMITS, validCalendarDate };
