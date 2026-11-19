// Shared support-ticket constants. The support address comes only from the environment: nothing is invented.
// NEXT_PUBLIC_ variables are baked in at build time, so changing it needs a rebuild.
const configured = (process.env.NEXT_PUBLIC_SUPPORT_EMAIL || '').trim();
export const SUPPORT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured) ? configured : '';

export const CATEGORIES = [
  { id: 'LOGIN', label: 'Login Problems' },
  { id: 'ACCOUNT', label: 'Account Issues' },
  { id: 'ACTIVITY_SUBMISSION', label: 'Activity Submission' },
  { id: 'DOCUMENT_UPLOAD', label: 'Document Upload' },
  { id: 'VERIFICATION', label: 'Verification Problems' },
  { id: 'TECHNICAL', label: 'Technical Issues' },
  { id: 'OTHER', label: 'Other' },
];

export const STATUS_LABEL = { OPEN: 'Open', IN_PROGRESS: 'In Progress', RESOLVED: 'Resolved' };
export const STATUS_STYLE = {
  OPEN: 'border-warn-line bg-warn-soft text-warn-text',
  IN_PROGRESS: 'border-brand-line bg-brand-soft text-brand-text',
  RESOLVED: 'border-success-line bg-success-soft text-success-text',
};
export const LIMITS = { name: 100, subject: 120, message: 2000, notes: 2000 };
