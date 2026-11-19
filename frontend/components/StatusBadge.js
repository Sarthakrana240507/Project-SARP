export default function StatusBadge({ status }) {
  const map = {
    draft: {
      label: 'Draft',
      style: 'border border-slate-300 bg-slate-100 text-slate-700',
      icon: (
        <svg className="h-3 w-3 text-ink-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      ),
    },
    pending: {
      label: 'Pending Review',
      style: 'border border-amber-200 bg-amber-50 text-amber-800',
      icon: (
        <svg className="h-3 w-3 text-warn-text" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
        </svg>
      ),
    },
    resubmitted: {
      label: 'Resubmitted',
      style: 'border border-blue-200 bg-blue-50 text-blue-800',
      icon: (
        <svg className="h-3 w-3 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      ),
    },
    correction_requested: {
      label: 'Correction Needed',
      style: 'border border-orange-200 bg-orange-50 text-orange-800',
      icon: (
        <svg className="h-3 w-3 text-flame-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ),
    },
    approved: {
      label: 'Verified',
      style: 'border border-emerald-200 bg-emerald-50 text-emerald-800',
      icon: (
        <svg className="h-3 w-3 text-success-text" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
        </svg>
      ),
    },
    rejected: {
      label: 'Rejected',
      style: 'border border-rose-200 bg-rose-50 text-rose-800',
      icon: (
        <svg className="h-3 w-3 text-danger-text" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
        </svg>
      ),
    },
  };

  const item = map[status] || {
    label: status ? status.replace(/_/g, ' ') : 'Unknown',
    style: 'border border-slate-200 bg-slate-100 text-ink-body',
    icon: <span className="h-1.5 w-1.5 rounded-full bg-slate-400"></span>,
  };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize tracking-wide ${item.style}`}>
      {item.icon}
      <span>{item.label}</span>
    </span>
  );
}
