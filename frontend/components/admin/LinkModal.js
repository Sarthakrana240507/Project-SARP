import { useState } from 'react';

// Shows a one-time activation / reset link to the administrator exactly once.
export default function LinkModal({ user, purpose, link, expiresAt, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* user can select the text manually */ }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="One-time link">
      <div className="card card-pad w-full max-w-lg shadow-card">
        <p className="eyebrow">{purpose === 'ACTIVATION' ? 'Activation link' : 'Password reset link'}</p>
        <h3 className="section-title mt-1">{user.name}</h3>
        <p className="text-xs text-ink-secondary">{user.email}</p>
        <textarea readOnly value={link} rows={3} onFocus={(e) => e.target.select()} data-testid="one-time-link"
          className="mt-4 w-full rounded-xl border border-line bg-surface-alt p-3 font-mono text-[11px] text-ink" />
        <p className="mt-2 text-[11px] text-ink-secondary">
          Shown once and not stored. Give it only to {user.name}. It works one time and expires on {new Date(expiresAt).toLocaleString()}.
          Creating a new link cancels this one.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary px-4 py-2 text-xs" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
          <button className="btn-primary px-4 py-2 text-xs" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
