import { useCallback, useEffect, useRef, useState } from 'react';
import { getAdminAudit } from '@/lib/api';

const PAGE = 15;
const DEFAULTS = { search: '', action: 'all', date_from: '', date_to: '' };
const pretty = (a) => a.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// One readable line for the details object (values only; the server never stores secrets here).
function summarise(d) {
  if (!d || typeof d !== 'object') return '';
  const flat = (v) => (v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${flat(x)}`).join(', ') : String(v ?? '—'));
  return flat(d);
}

export default function AuditLogPanel() {
  const [filters, setFilters] = useState(DEFAULTS);
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ entries: [], total: 0, pages: 1, actions: [] });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);
  const appliedSearch = useRef('');
  appliedSearch.current = filters.search;

  useEffect(() => {
    const t = setTimeout(() => {
      const text = searchInput.trim();
      if (text === appliedSearch.current) return;
      setFilters((f) => ({ ...f, search: text }));
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    const mine = ++requestId.current;
    setLoading(true);
    try {
      const r = await getAdminAudit({ ...filters, page, limit: PAGE });
      if (mine !== requestId.current) return;
      setData(r);
      setError('');
    } catch (e) {
      if (mine === requestId.current) setError(e.message);
    } finally {
      if (mine === requestId.current) setLoading(false);
    }
  }, [filters, page]);
  useEffect(() => { load(); }, [load]);

  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const reset = () => { setFilters(DEFAULTS); setSearchInput(''); setPage(1); };
  const active = JSON.stringify({ ...filters, search: searchInput.trim() }) !== JSON.stringify(DEFAULTS);

  return (
    <div className="mt-6 card card-pad" data-testid="audit-panel">
      <h2 className="section-title text-sm">Administrator audit log</h2>
      <p className="mt-1 text-xs text-ink-secondary">Who did what, and when. Entries are append-only: they cannot be edited or deleted, even by an administrator.</p>
      <div data-testid="audit-filters" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <input className="field lg:col-span-2" aria-label="Search audit log" placeholder="Search actor, action or target…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select className="field" aria-label="Action" value={filters.action} onChange={(e) => setFilter('action', e.target.value)}>
          <option value="all">All actions</option>
          {data.actions.map((a) => <option key={a} value={a}>{pretty(a)}</option>)}
        </select>
        <input type="date" className="field" aria-label="From date" value={filters.date_from} onChange={(e) => setFilter('date_from', e.target.value)} />
        <input type="date" className="field" aria-label="To date" value={filters.date_to} onChange={(e) => setFilter('date_to', e.target.value)} />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-ink-secondary">
        <button type="button" data-testid="audit-reset" className="btn-secondary py-1.5 text-xs" disabled={!active} onClick={reset}>Reset filters</button>
        <span><strong>{data.total}</strong> event{data.total === 1 ? '' : 's'}</span>
      </div>
      {error && <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-danger-soft p-3 text-xs font-semibold text-danger-text">{error}</p>}
      <div className={`mt-3 overflow-x-auto rounded-xl border border-line ${loading ? 'opacity-60' : ''}`}>
        <table data-testid="audit-table" className="w-full min-w-[720px] text-left text-xs">
          <thead className="bg-surface-alt text-[10px] font-bold uppercase tracking-wider text-ink-secondary">
            <tr><th className="px-4 py-3">When</th><th className="px-4 py-3">Actor</th><th className="px-4 py-3">Action</th><th className="px-4 py-3">Target</th><th className="px-4 py-3">Details</th></tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {data.entries.map((e) => (
              <tr key={e.id} data-testid={`audit-${e.id}`}>
                <td className="whitespace-nowrap px-4 py-3 text-ink-body">{new Date(e.created_at).toLocaleString()}</td>
                <td className="px-4 py-3"><p className="font-bold text-ink-strong">{e.actor_name || 'System'}</p>{e.actor_label && e.actor_label !== e.actor_name && <p className="text-[10px] text-ink-secondary">{e.actor_label}</p>}</td>
                <td className="px-4 py-3 font-semibold text-ink-strong">{pretty(e.action)}</td>
                <td className="px-4 py-3 text-ink-body">{e.target_type ? `${e.target_type} #${e.target_id}` : '—'}</td>
                <td className="max-w-[320px] break-words px-4 py-3 text-[11px] text-ink-secondary [overflow-wrap:anywhere]">{summarise(e.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && data.entries.length === 0 && <p className="p-6 text-center text-xs text-ink-secondary">{active ? 'No events match these filters.' : 'No administrator events yet.'}</p>}
      </div>
      {data.total > 0 && (
        <div data-testid="audit-pagination" className="mt-3 flex items-center justify-between text-xs text-ink-secondary">
          <span>Page {page} of {data.pages}</span>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary py-1.5 text-xs" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
            <button type="button" className="btn-secondary py-1.5 text-xs" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
