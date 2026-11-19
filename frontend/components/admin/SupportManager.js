import { useCallback, useEffect, useRef, useState } from 'react';
import { getAdminSupportTickets, updateAdminSupportTicket } from '@/lib/api';
import { CATEGORIES, STATUS_LABEL, STATUS_STYLE, LIMITS } from '@/lib/support';
import { formatWhen } from '@/lib/notifications';

const PAGE = 10;
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];

export default function SupportManager() {
  const [filters, setFilters] = useState({ search: '', status: 'all', category: 'all' });
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ tickets: [], total: 0, pages: 1, counts: { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0 } });
  const [selected, setSelected] = useState(null); // ticket_ref
  const [draft, setDraft] = useState({ status: 'OPEN', admin_notes: '' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => { setFilters((f) => (f.search === searchInput.trim() ? f : { ...f, search: searchInput.trim() })); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    const mine = ++requestId.current;
    try {
      const r = await getAdminSupportTickets({ ...filters, page, limit: PAGE });
      if (mine === requestId.current) { setData(r); setError(''); }
    } catch (err) { if (mine === requestId.current) setError(err.message); }
  }, [filters, page]);
  useEffect(() => { load(); }, [load]);

  const choose = (t) => {
    if (selected === t.ticket_ref) { setSelected(null); return; }
    setSelected(t.ticket_ref); setSaved('');
    setDraft({ status: t.status, admin_notes: t.admin_notes || '' });
  };
  const setFilter = (k) => (e) => { setFilters((f) => ({ ...f, [k]: e.target.value })); setPage(1); };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(''); setSaved('');
    try {
      await updateAdminSupportTicket(selected, draft);
      setSaved('Ticket updated.');
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4" data-testid="support-manager">
      <div className="flex flex-wrap gap-2 text-[11px] font-bold">
        {STATUSES.map((s) => (
          <span key={s} className={`rounded-full border px-3 py-1 ${STATUS_STYLE[s]}`} data-testid={`count-${s}`}>{STATUS_LABEL[s]}: {data.counts[s]}</span>
        ))}
      </div>

      <div className="card card-pad grid gap-3 sm:grid-cols-3">
        <div>
          <label className="field-label" htmlFor="s-search">Search ticket ID</label>
          <input id="s-search" className="field" placeholder="e.g. SUP-000012" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} data-testid="ticket-search" />
        </div>
        <div>
          <label className="field-label" htmlFor="s-status">Status</label>
          <select id="s-status" className="field" value={filters.status} onChange={setFilter('status')} data-testid="ticket-status-filter">
            <option value="all">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="s-cat">Category</label>
          <select id="s-cat" className="field" value={filters.category} onChange={setFilter('category')} data-testid="ticket-category-filter">
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
      </div>

      {error && <p className="text-xs font-semibold text-danger-text" role="alert" data-testid="support-error">{error}</p>}

      <div className="card overflow-hidden">
        {data.tickets.length === 0 ? (
          <p className="p-6 text-xs text-ink-secondary" data-testid="support-empty">No tickets match these filters.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.tickets.map((t) => (
              <li key={t.ticket_ref} data-testid={`admin-ticket-${t.ticket_ref}`}>
                <button type="button" onClick={() => choose(t)} aria-expanded={selected === t.ticket_ref}
                  className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-surface-alt">
                  <span className="min-w-0">
                    <span className="font-mono text-[11px] font-bold text-ink-secondary">{t.ticket_ref}</span>
                    <span className="block truncate text-xs font-bold text-ink-strong">{t.subject}</span>
                    <span className="block text-[11px] text-ink-secondary">{t.category_label} · {t.name} · {formatWhen(t.created_at)}</span>
                  </span>
                  <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_STYLE[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                </button>
                {selected === t.ticket_ref && (
                  <form onSubmit={save} className="space-y-3 border-t border-line bg-surface-alt px-4 py-4" data-testid="ticket-detail">
                    <p className="text-[11px] text-ink-secondary">From {t.name} &lt;{t.email}&gt;</p>
                    <p className="whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-3 text-xs text-ink-body" data-testid="ticket-message">{t.message}</p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div>
                        <label className="field-label" htmlFor="d-status">Status</label>
                        <select id="d-status" className="field" value={draft.status} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))} data-testid="detail-status">
                          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                        </select>
                      </div>
                      <div className="sm:col-span-2">
                        <label className="field-label" htmlFor="d-notes">Internal resolution notes (never shown to the user)</label>
                        <textarea id="d-notes" className="field min-h-[80px]" maxLength={LIMITS.notes} value={draft.admin_notes} onChange={(e) => setDraft((d) => ({ ...d, admin_notes: e.target.value }))} data-testid="detail-notes" />
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <button type="submit" className="btn-primary" disabled={busy} data-testid="detail-save">{busy ? 'Saving…' : 'Save changes'}</button>
                      {saved && <span className="text-xs font-semibold text-success-text" role="status" data-testid="detail-saved">{saved}</span>}
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {data.pages > 1 && (
        <div className="flex items-center justify-between text-[11px] text-ink-secondary" data-testid="support-pagination">
          <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span>Page {page} of {data.pages} · {data.total} tickets</span>
          <button type="button" className="btn-secondary" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
