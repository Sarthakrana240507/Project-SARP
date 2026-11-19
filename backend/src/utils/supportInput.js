// Validation for support tickets. Plain functions so routes and tests share one set of rules.
const CATEGORIES = {
  LOGIN: 'Login Problems',
  ACCOUNT: 'Account Issues',
  ACTIVITY_SUBMISSION: 'Activity Submission',
  DOCUMENT_UPLOAD: 'Document Upload',
  VERIFICATION: 'Verification Problems',
  TECHNICAL: 'Technical Issues',
  OTHER: 'Other',
};
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];
const LIMITS = { name: [2, 100], subject: [5, 120], message: [10, 2000], notes: [0, 2000] };

// Collapse stray control characters; keep line breaks in long text.
const clean = (v, multiline) => String(v ?? '')
  .replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, '')
  .replace(multiline ? /[ \t]+/g : /\s+/g, ' ')
  .trim();

function validateTicket(body, accountEmail) {
  const b = body || {};
  const v = { name: clean(b.name), email: clean(b.email).toLowerCase(), category: String(b.category || ''), subject: clean(b.subject), message: clean(b.message, true) };
  const errors = {};
  if (v.name.length < LIMITS.name[0] || v.name.length > LIMITS.name[1]) errors.name = `Name must be ${LIMITS.name[0]}-${LIMITS.name[1]} characters.`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = 'Enter a valid email address.';
  else if (v.email !== String(accountEmail || '').toLowerCase()) errors.email = 'Use the email address registered to your account.';
  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, v.category)) errors.category = 'Choose an issue category.';
  if (v.subject.length < LIMITS.subject[0] || v.subject.length > LIMITS.subject[1]) errors.subject = `Subject must be ${LIMITS.subject[0]}-${LIMITS.subject[1]} characters.`;
  if (v.message.length < LIMITS.message[0] || v.message.length > LIMITS.message[1]) errors.message = `Message must be ${LIMITS.message[0]}-${LIMITS.message[1]} characters.`;
  return { values: v, errors };
}

module.exports = { CATEGORIES, STATUSES, LIMITS, validateTicket, clean };
