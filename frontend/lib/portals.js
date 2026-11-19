// The three entry points. The portal chosen here is only a check sent with the sign-in: the server decides the real role.
export const PORTALS = {
  student: { id: 'student', title: 'Student Portal', short: 'Student', blurb: 'Submit achievements with evidence and follow their verification.', icon: 'academic', tone: 'bg-brand-soft text-brand-text' },
  faculty: { id: 'faculty', title: 'Faculty Portal', short: 'Faculty', blurb: 'Review submissions, check evidence and keep the verification record.', icon: 'badge', tone: 'bg-accent-soft text-accent-text' },
  admin: { id: 'admin', title: 'Administrator Access', short: 'Administrator', blurb: 'Manage accounts, institutional records, reports and support tickets.', icon: 'shield', tone: 'bg-surface-sub text-ink-strong' },
};
export const PORTAL_IDS = Object.keys(PORTALS);
