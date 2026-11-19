// The ONE place that defines how an activity may move between statuses, and who may move it.
//
//   draft ──student──> pending ──reviewer──> approved
//                         │  └─────────────> rejected
//                         └────────────────> correction_requested ──student──> resubmitted ──reviewer──> (same three)
//
// approved and rejected are final. Every route that changes a status asks transitionProblem() first.
const STATUSES = ['draft', 'pending', 'resubmitted', 'approved', 'rejected', 'correction_requested'];
const REVIEWABLE = ['pending', 'resubmitted'];

const REVIEW_OUTCOMES = { approved: 'reviewer', rejected: 'reviewer', correction_requested: 'reviewer' };
const TRANSITIONS = {
  draft: { pending: 'student' },
  pending: REVIEW_OUTCOMES,
  resubmitted: REVIEW_OUTCOMES,
  correction_requested: { resubmitted: 'student' },
  approved: {},
  rejected: {},
};

const label = (s) => String(s).replace(/_/g, ' ');
const actorKind = (role) => (role === 'student' ? 'student' : 'reviewer');

/** Returns null when the move is allowed, otherwise a human-readable reason. */
function transitionProblem(from, to, role) {
  const allowed = TRANSITIONS[from];
  if (!allowed) return `Unknown activity status "${from}"`;
  if (Object.keys(allowed).length === 0) return `This activity is already ${label(from)} and can no longer be changed`;
  if (!(to in allowed)) return `An activity that is ${label(from)} cannot become ${label(to)}`;
  if (allowed[to] !== actorKind(role)) return `Only a ${allowed[to]} can make this change`;
  return null;
}

module.exports = { STATUSES, REVIEWABLE, TRANSITIONS, transitionProblem };
