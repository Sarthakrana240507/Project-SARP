import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import StatusBadge from '@/components/StatusBadge';
import {
  apiFetch, getToken, getUser, getProfile, viewProofDocument, fetchProofBlob,
  getPendingActivities, getReviewHistory, getReviewSummary, getActivityOptions, getActivity, getActivityAudit,
} from '@/lib/api';

const PAGE_SIZE = 10;
const categoryLabel = (c = '') => c.charAt(0).toUpperCase() + c.slice(1);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');

const categoryColors = {
  hackathon: 'bg-brand-soft text-brand-text border-brand-line',
  certification: 'bg-violet-soft text-violet-text border-violet-line',
  workshop: 'bg-accent-soft text-accent-text border-accent-line',
  sports: 'bg-warn-soft text-warn-text border-warn-line',
  internship: 'bg-success-soft text-success-text border-success-line',
  publication: 'bg-pink-soft text-pink-text border-pink-line',
  volunteering: 'bg-flame-soft text-flame-text border-flame-line',
};

const DEFAULT_FILTERS = {
  search: '', department: 'all', category: 'all', academic_session: 'all', semester: 'all', status: 'all',
  date_from: '', date_to: '', sort: '', duplicate: false, reviewed_by: '',
};

export default function FacultyVerificationCenter() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('pending'); // 'pending' | 'history'
  const [scope, setScope] = useState(null); // faculty only: which departments this reviewer may verify
  const [summary, setSummary] = useState(null);
  const [options, setOptions] = useState({ categories: [], academic_years: [], semesters: [] });

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ activities: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [proofLoading, setProofLoading] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const token = getToken();
    const u = getUser();
    if (!token || !u) {
      router.replace('/login');
      return;
    }
    if (!['faculty', 'admin'].includes(u.role)) {
      router.replace('/dashboard');
      return;
    }
    setUser(u);
    getActivityOptions().then(setOptions).catch(() => {});
    if (u.role === 'faculty') getProfile().then(({ user: me }) => setScope(me.verification_scope || null)).catch(() => {});
  }, [router]);

  const loadSummary = useCallback(() => getReviewSummary().then(setSummary).catch((e) => setError(e.message)), []);
  useEffect(() => { if (user) loadSummary(); }, [user, loadSummary]);

  // The search box waits for a short pause in typing before it asks the server.
  // (It only touches the page number when the search text really changed, so it can't undo a click on "Next".)
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

  const loadList = useCallback(async () => {
    if (!user) return;
    const mine = ++requestId.current; // an older, slower response must never overwrite a newer one
    setLoading(true);
    try {
      const fetcher = activeTab === 'pending' ? getPendingActivities : getReviewHistory;
      const result = await fetcher({ ...filters, page, limit: PAGE_SIZE });
      if (mine !== requestId.current) return;
      setData(result);
      setError('');
    } catch (e) {
      if (mine === requestId.current) setError(e.message);
    } finally {
      if (mine === requestId.current) setLoading(false);
    }
  }, [user, activeTab, filters, page]);
  useEffect(() => { loadList(); }, [loadList]);

  const setFilter = (key, value) => { setFilters((f) => ({ ...f, [key]: value })); setPage(1); };
  const resetFilters = () => { setFilters(DEFAULT_FILTERS); setSearchInput(''); setPage(1); };
  const switchTab = (tab) => { if (tab === activeTab) return; setActiveTab(tab); resetFilters(); };
  const filtersActive = JSON.stringify({ ...filters, search: searchInput.trim() }) !== JSON.stringify(DEFAULT_FILTERS);

  const flash = (message) => { setToast(message); setTimeout(() => setToast(''), 4500); };

  const handleOpenProof = async (id) => {
    setProofLoading(true);
    try {
      await viewProofDocument(id);
    } catch (err) {
      setError(err.message);
    } finally {
      setProofLoading(false);
    }
  };

  const onDecided = (updated, decision) => {
    setSelectedId(null);
    flash(
      decision === 'approve'
        ? `✓ Activity #${updated.id} verified and added to the student's portfolio.`
        : decision === 'correction'
        ? `✓ Correction requested for activity #${updated.id}. The student has been notified.`
        : `✓ Activity #${updated.id} rejected. The student has been notified.`
    );
    loadSummary();
    loadList();
  };

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-xs font-semibold text-ink-secondary">
        Loading Verification Center…
      </div>
    );
  }

  const isQueue = activeTab === 'pending';
  const stat = (k) => (summary ? summary[k] : '…');

  return (
    <div className="app-shell">
      <main className="page-wrap">
        {/* Header Banner */}
        <div className="rounded-2xl border border-brand-line bg-gradient-to-r from-brand-soft via-surface to-accent-soft p-6 shadow-sm sm:p-7">
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-6 items-center rounded-md bg-navy px-2 text-[10px] font-bold uppercase tracking-wider text-white">
                  Faculty Console
                </span>
                <span className="text-xs font-semibold text-ink-secondary">
                  {user.department || 'Academic Committee'}
                </span>
              </div>
              <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink-strong sm:text-3xl">
                Verification Center
              </h1>
              <p className="mt-1 text-xs text-ink-secondary sm:text-sm">
                Inspect submitted evidence, analyze SHA-256 integrity signals, and record binding verification decisions.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Link href="/analytics" className="btn-secondary">
                <svg className="h-3.5 w-3.5 text-brand-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                View Institutional Analytics →
              </Link>
            </div>
          </div>
        </div>

        {scope && (
          <div data-testid="scope-banner" className={`mt-5 rounded-xl border p-3 text-xs font-semibold ${
            !scope.all && scope.departments.length === 0 ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-brand-line bg-brand-soft text-brand-strong'}`}>
            {scope.all
              ? 'You can verify activities from all departments.'
              : scope.departments.length
                ? `You can verify activities from: ${scope.departments.join(', ')}.`
                : 'You have no verification scope yet, so the queue is empty. Ask an administrator to assign your departments.'}
          </div>
        )}


        {error && (
          <div role="alert" className="mt-5 rounded-xl border border-rose-200 bg-danger-soft p-4 text-xs font-semibold text-danger-text">
            {error}
          </div>
        )}

        {/* Dashboard numbers: counted by the server, limited to this reviewer's scope */}
        <div data-testid="review-stats" className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard id="pending" label="Pending Review" value={stat('pending')} description={summary ? `${summary.resubmitted} resubmitted` : ' '} icon="⏳" iconBg="bg-warn-soft" accentBorder="border-l-amber-500" />
          <StatCard id="approved" label="Approved" value={stat('approved')} description="Verified records" icon="✓" iconBg="bg-accent-soft" accentBorder="border-l-accent" />
          <StatCard id="rejected" label="Rejected" value={stat('rejected')} description="Declined with remarks" icon="✕" iconBg="bg-danger-soft" accentBorder="border-l-rose-500" />
          <StatCard id="correction_requested" label="Corrections Requested" value={stat('correction_requested')} description="Waiting for the student" icon="✎" iconBg="bg-flame-soft" accentBorder="border-l-orange-500" />
          <StatCard id="duplicate_warnings" label="Duplicate Warnings" value={stat('duplicate_warnings')} description="Same file seen before" icon="⚠" iconBg="bg-warn-soft" accentBorder="border-l-amber-600" />
        </div>

        {summary && summary.recently_reviewed.length > 0 && (
          <section data-testid="recent-reviews" className="card mt-5 p-4 sm:p-5">
            <p className="eyebrow">Recently reviewed</p>
            <ul className="mt-3 divide-y divide-line-soft">
              {summary.recently_reviewed.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                  <span className="min-w-0 truncate">
                    <Link href={`/activity/${r.id}`} className="font-bold text-ink-strong hover:underline">{r.title}</Link>
                    <span className="text-ink-secondary"> · {r.student_name}</span>
                  </span>
                  <span className="flex items-center gap-2 text-ink-secondary">
                    <StatusBadge status={r.status} />
                    {fmtDate(r.reviewed_at)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Navigation Tabs */}
        <div className="mt-7 flex items-center gap-2 border-b border-line">
          {[['pending', 'Pending Review Queue', summary?.pending], ['history', 'Review History', summary ? summary.approved + summary.rejected + summary.correction_requested : undefined]].map(([key, label, count]) => (
            <button
              key={key}
              data-testid={`tab-${key}`}
              onClick={() => switchTab(key)}
              className={`flex items-center gap-2 border-b-2 px-5 py-3 text-xs font-bold transition-all ${
                activeTab === key ? 'border-navy text-ink-strong' : 'border-transparent text-ink-secondary hover:text-ink-strong'
              }`}
            >
              <span>{label}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${activeTab === key ? 'bg-navy text-white' : 'bg-line text-ink-secondary'}`}>
                {count ?? '…'}
              </span>
            </button>
          ))}
        </div>

        {/* Filters: every one of them is sent to the server */}
        <div data-testid="filter-bar" className="card mt-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <input
            className="field lg:col-span-2"
            aria-label="Search records"
            placeholder="Search student name, email, enrolment number or activity title…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <select className="field" aria-label="Department" value={filters.department} onChange={(e) => setFilter('department', e.target.value)}>
            <option value="all">All departments</option>
            {(summary?.departments || []).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select className="field" aria-label="Category" value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
            <option value="all">All categories</option>
            {options.categories.map((c) => <option key={c.name} value={c.name}>{c.display_name}</option>)}
          </select>
          <select className="field" aria-label="Status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="all">{isQueue ? 'Pending and resubmitted' : 'All outcomes'}</option>
            {isQueue ? (
              <>
                <option value="pending">New submissions</option>
                <option value="resubmitted">Resubmitted</option>
              </>
            ) : (
              <>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="correction_requested">Correction requested</option>
              </>
            )}
          </select>
          <select className="field" aria-label="Academic year" value={filters.academic_session} onChange={(e) => setFilter('academic_session', e.target.value)}>
            <option value="all">All academic years</option>
            {options.academic_years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <select className="field" aria-label="Semester" value={filters.semester} onChange={(e) => setFilter('semester', e.target.value)}>
            <option value="all">All semesters</option>
            {options.semesters.map((s) => <option key={s} value={s}>Semester {s}</option>)}
          </select>
          <select className="field" aria-label="Sort order" value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)}>
            {isQueue ? (
              <>
                <option value="">Waiting longest first</option>
                <option value="newest">Newest first</option>
              </>
            ) : (
              <>
                <option value="">Recently reviewed first</option>
                <option value="reviewed_oldest">Oldest review first</option>
                <option value="newest">Newest submission first</option>
                <option value="oldest">Oldest submission first</option>
              </>
            )}
          </select>
          <label className="flex items-center gap-2 text-xs font-semibold text-ink-body">
            Submitted from
            <input type="date" className="field" aria-label="Submitted from" value={filters.date_from} onChange={(e) => setFilter('date_from', e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-ink-body">
            to
            <input type="date" className="field" aria-label="Submitted to" value={filters.date_to} onChange={(e) => setFilter('date_to', e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-4 text-xs font-semibold text-ink-body lg:col-span-2">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" aria-label="Only duplicate warnings" checked={filters.duplicate} onChange={(e) => setFilter('duplicate', e.target.checked)} />
              Duplicate warnings only
            </label>
            {!isQueue && (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" aria-label="Reviewed by me" checked={filters.reviewed_by === 'me'} onChange={(e) => setFilter('reviewed_by', e.target.checked ? 'me' : '')} />
                Reviewed by me
              </label>
            )}
            <button type="button" data-testid="reset-filters" className="btn-secondary py-1.5 text-xs" disabled={!filtersActive} onClick={resetFilters}>
              Reset filters
            </button>
            <span className="ml-auto text-ink-secondary">
              <strong>{data.total}</strong> record{data.total === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <section className="card mt-4 overflow-hidden">
          {loading && data.activities.length === 0 ? (
            <div className="p-12 text-center text-xs font-semibold text-ink-secondary">
              <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-navy border-t-transparent"></div>
              <p className="mt-2">Loading…</p>
            </div>
          ) : data.activities.length === 0 ? (
            <div className="p-14 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-2xl text-accent-text">{isQueue ? '✓' : '📋'}</div>
              <p className="mt-3.5 font-bold text-ink-strong">
                {filtersActive ? 'No matching records' : isQueue ? 'Verification queue is clear' : 'No review history yet'}
              </p>
              <p className="mt-1 text-xs text-ink-secondary">
                {filtersActive ? 'Try changing or resetting the filters.' : isQueue ? 'Nothing is waiting for your decision.' : 'Decisions you and your colleagues make will appear here.'}
              </p>
            </div>
          ) : (
            <div className={`divide-y divide-line-soft ${loading ? 'opacity-60' : ''}`}>
              {data.activities.map((a) => (
                <ActivityRow key={a.id} a={a} isQueue={isQueue} onReview={() => setSelectedId(a.id)} onProof={() => handleOpenProof(a.id)} proofLoading={proofLoading} />
              ))}
            </div>
          )}
        </section>

        {data.total > 0 && (
          <div data-testid="pagination" className="mt-4 flex items-center justify-between text-xs text-ink-secondary">
            <span>Page {page} of {data.pages} · {data.total} record{data.total === 1 ? '' : 's'}</span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary py-1.5 text-xs" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
              <button type="button" className="btn-secondary py-1.5 text-xs" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        )}
      </main>

      {selectedId && (
        <ReviewModal
          activityId={selectedId}
          onClose={() => setSelectedId(null)}
          onDecided={onDecided}
          onStale={() => { loadList(); loadSummary(); }}
        />
      )}

      {toast && (
        <div className="toast">
          <span className="text-accent-text font-bold">✓</span>
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}

function StatCard({ id, label, value, description, icon, iconBg, accentBorder }) {
  return (
    <div data-testid={`stat-${id}`} className={`card flex items-center gap-3 border-l-4 p-4 ${accentBorder}`}>
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg ${iconBg}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-ink-secondary">{label}</p>
        <p className="text-2xl font-bold leading-tight text-ink-strong" data-testid={`stat-value-${id}`}>{value}</p>
        <p className="truncate text-[11px] text-ink-muted">{description}</p>
      </div>
    </div>
  );
}

function ActivityRow({ a, isQueue, onReview, onProof, proofLoading }) {
  const catClass = categoryColors[a.category] || 'bg-slate-100 text-slate-700 border-slate-200';
  return (
    <div data-testid={`row-${a.id}`} className="flex flex-col gap-4 p-5 transition-colors hover:bg-surface-alt sm:p-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${catClass}`}>{categoryLabel(a.category)}</span>
          <h3 className="break-words text-sm font-bold text-ink-strong">{a.title}</h3>
          <StatusBadge status={a.status} />
          {a.version > 1 && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand-strong">v{a.version}</span>}
          {a.is_duplicate && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-warn-soft px-2 py-0.5 text-[10px] font-bold text-warn-text">⚠ Duplicate proof flag</span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-secondary">
          <span className="font-bold text-ink">{a.student_name}</span>
          <span>•</span>
          <span>{a.department || 'Department not specified'}</span>
          {a.academic_session && (<><span>•</span><span>{a.academic_session}{a.semester ? `, Sem ${a.semester}` : ''}</span></>)}
          <span>•</span>
          <span>Submitted {fmtDate(a.submitted_at || a.created_at)}</span>
          {!isQueue && (<><span>•</span><span>Reviewed {fmtDate(a.reviewed_at)}{a.reviewer_name ? ` by ${a.reviewer_name}` : ''}</span></>)}
        </div>
        {!isQueue && (a.review_remarks || a.correction_notes) && (
          <div className={`mt-2.5 rounded-xl border p-2.5 text-xs ${
            a.status === 'approved' ? 'border-emerald-200 bg-success-soft text-success-text'
              : a.status === 'rejected' ? 'border-rose-200 bg-danger-soft text-danger-text' : 'border-orange-200 bg-orange-50 text-orange-900'}`}>
            <strong>Remarks:</strong> {a.status === 'correction_requested' ? a.correction_notes : a.review_remarks}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pt-2 sm:pt-0">
        {isQueue ? (
          <button type="button" data-testid={`review-${a.id}`} className="btn-primary py-2 text-xs font-bold" onClick={onReview}>Review Evidence</button>
        ) : (
          a.has_proof && <button type="button" className="btn-secondary py-2 text-xs font-bold" disabled={proofLoading} onClick={onProof}>Inspect Proof</button>
        )}
        <Link href={`/activity/${a.id}`} className="btn-secondary py-2 text-xs font-bold">{isQueue ? 'Details & Timeline →' : 'Audit Trail →'}</Link>
      </div>
    </div>
  );
}

function ReviewModal({ activityId, onClose, onDecided, onStale }) {
  const [activity, setActivity] = useState(null);
  const [audit, setAudit] = useState([]);
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  const [preview, setPreview] = useState(null); // { url, type } for the inline proof preview
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewUrl = useRef(null);

  const load = useCallback(async () => {
    const [a, log] = await Promise.all([getActivity(activityId), getActivityAudit(activityId)]);
    setActivity(a);
    setAudit(log);
  }, [activityId]);
  useEffect(() => { load().catch((e) => setModalError(e.message)); }, [load]);
  useEffect(() => () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }, []);

  const showPreview = async () => {
    setPreviewBusy(true);
    setModalError('');
    try {
      const p = await fetchProofBlob(activityId);
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = p.url;
      setPreview(p);
    } catch (e) {
      setModalError(e.message);
    } finally {
      setPreviewBusy(false);
    }
  };

  const decide = async (decision) => {
    if (!activity) return;
    const text = remarks.trim();
    if (decision === 'reject' && !text) return setModalError('A clear rejection remark is mandatory so the student understands why the evidence was declined.');
    if (decision === 'correction' && !text) return setModalError('Correction instructions are mandatory so the student knows what to revise.');
    setBusy(true);
    setModalError('');
    try {
      // expected_version = the version this reviewer is looking at; the server refuses if the student has resubmitted since.
      const path = decision === 'correction' ? 'request-correction' : decision;
      const updated = await apiFetch(`/activities/${activity.id}/${path}`, {
        method: 'PATCH',
        body: { remarks: text, expected_version: activity.version },
      });
      onDecided(updated, decision);
    } catch (e) {
      setModalError(e.message);
      if (e.status === 409) { // someone else decided, or the student resubmitted: show what is true now
        onStale();
        load().catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };

  const earlier = audit.filter((x) => x.reviewer_id); // decisions made so far (the student's own steps have no reviewer)
  const dup = activity?.duplicate_info;
  const decided = activity && !['pending', 'resubmitted'].includes(activity.status);

  return (
    <div data-testid="review-modal" className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-5">
      <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-t-3xl border border-line bg-surface shadow-modal sm:rounded-3xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface/95 px-6 py-4 backdrop-blur-md">
          <div className="min-w-0">
            <p className="eyebrow">Faculty Review Console</p>
            <h2 className="mt-0.5 break-words text-lg font-bold text-ink-strong">{activity?.title || 'Loading…'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-xl text-ink-secondary transition hover:bg-surface-sub hover:text-ink-strong">✕</button>
        </div>

        {modalError && (
          <div role="alert" data-testid="modal-error" className="mx-6 mt-4 rounded-xl border border-rose-200 bg-danger-soft p-3 text-xs font-semibold text-danger-text">{modalError}</div>
        )}

        {activity && (
          <div className="grid gap-6 p-6 sm:p-7 lg:grid-cols-[1fr_360px]">
            <div className="min-w-0 space-y-5">
              <section className="rounded-2xl border border-line bg-surface-alt p-5">
                <p className="eyebrow">Student & Submission Information</p>
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Info label="Student" value={activity.student_name} />
                  <Info label="Email" value={activity.student_email} />
                  <Info label="Department" value={activity.department || 'Not specified'} />
                  <Info label="Category" value={categoryLabel(activity.category)} />
                  <Info label="Activity date" value={activity.activity_date ? new Date(`${activity.activity_date}T00:00:00`).toLocaleDateString() : '—'} />
                  <Info label="Academic year / semester" value={`${activity.academic_session || '—'}${activity.semester ? ` · Sem ${activity.semester}` : ''}`} />
                  <Info label="Submission" value={`Version ${activity.version}${activity.resubmitted_at ? ` · resubmitted ${new Date(activity.resubmitted_at).toLocaleDateString()}` : ''}`} />
                  <Info label="First created" value={new Date(activity.created_at).toLocaleString()} />
                  <div className="sm:col-span-2">
                    <p className="field-label">Description</p>
                    <p className="whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-3 text-xs leading-relaxed text-ink-secondary">
                      {activity.description || 'No description provided by the student.'}
                    </p>
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-line bg-surface p-5">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0">
                    <p className="eyebrow">Uploaded Proof Evidence</p>
                    <p className="mt-1 break-all text-xs font-bold text-ink-strong">{activity.proof_original_name || 'Uploaded document'}</p>
                    {activity.proof_size ? <p className="text-[11px] text-ink-secondary">{(activity.proof_size / 1024 / 1024).toFixed(2)} MB · {activity.proof_mime_type}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" data-testid="preview-proof" className="btn-secondary" disabled={previewBusy || !activity.has_proof} onClick={showPreview}>
                      {previewBusy ? 'Loading…' : preview ? 'Reload preview' : 'Preview here'}
                    </button>
                    <button type="button" className="btn-secondary" disabled={!activity.has_proof} onClick={() => viewProofDocument(activity.id).catch((e) => setModalError(e.message))}>Open in new tab ↗</button>
                  </div>
                </div>
                {preview && (
                  <div data-testid="proof-preview" className="mt-4 overflow-hidden rounded-xl border border-line bg-surface-alt">
                    {preview.type.startsWith('image/') ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={preview.url} alt="Uploaded proof" className="mx-auto max-h-[420px] w-auto max-w-full" />
                    ) : (
                      <iframe src={preview.url} title="Uploaded proof" className="h-[420px] w-full" />
                    )}
                  </div>
                )}
                {activity.is_duplicate && (
                  <div data-testid="duplicate-info" className="mt-4 rounded-xl border border-amber-200 bg-warn-soft p-3 text-xs leading-5 text-warn-text">
                    <strong>⚠ Duplicate evidence warning.</strong> This file is byte-for-byte identical to one submitted earlier
                    {dup?.id ? (
                      <> — <Link href={`/activity/${dup.id}`} className="font-bold underline">“{dup.title}” by {dup.student_name}</Link> ({dup.status.replace('_', ' ')})</>
                    ) : dup?.out_of_scope ? <> — in a department outside your scope</> : null}.
                    The same file can be legitimate (for example, a team certificate), so please inspect it yourself. It is not treated as fraud.
                  </div>
                )}
              </section>

              <section data-testid="review-history" className="rounded-2xl border border-line bg-surface p-5">
                <p className="eyebrow">Previous review history</p>
                {earlier.length === 0 ? (
                  <p className="mt-2 text-xs text-ink-secondary">No decision has been recorded on this activity yet.</p>
                ) : (
                  <ol className="mt-3 space-y-2">
                    {earlier.map((x) => (
                      <li key={x.id} className="rounded-xl border border-line-soft bg-surface-alt p-3 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-bold text-ink-strong">{x.new_status.replace('_', ' ')} <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] text-brand-strong">v{x.version}</span></span>
                          <span className="text-[10px] text-ink-muted">{new Date(x.created_at).toLocaleString()}</span>
                        </div>
                        {x.remarks && <p className="mt-1 break-words text-ink-secondary">{x.remarks}</p>}
                        <p className="mt-1 text-[10px] text-ink-muted">By {x.reviewer_name || 'a reviewer'}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>

            <aside className="min-w-0 space-y-5">
              <section className="rounded-2xl border border-brand-line bg-brand-soft/60 p-5">
                <p className="eyebrow">Cryptographic Integrity</p>
                <div className="mt-4 space-y-2.5 text-xs">
                  <Signal ok={!!activity.has_proof} text="Proof attached & accessible" />
                  <Signal ok={!!activity.file_hash} text="SHA-256 digest computed" />
                  <Signal ok={!activity.is_duplicate} warn={activity.is_duplicate} text={activity.is_duplicate ? 'Same file seen in an earlier submission' : 'Unique proof digest on record'} />
                </div>
                {activity.file_hash && (
                  <div className="mt-4 border-t border-brand-line pt-3">
                    <p className="field-label">SHA-256 digest</p>
                    <p className="break-all rounded-xl border border-brand-line bg-surface p-2.5 font-mono text-[10px] leading-4 text-ink-strong">{activity.file_hash}</p>
                    <p className="mt-2 text-[10px] leading-4 text-ink-secondary">The digest shows the file is the same bytes as one seen before. It does not prove a certificate is genuine.</p>
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-line bg-surface p-5">
                {decided ? (
                  <p data-testid="already-decided" className="text-xs font-semibold text-ink-body">
                    This activity is now <strong>{activity.status.replace('_', ' ')}</strong>, so no further decision can be recorded.
                  </p>
                ) : (
                  <>
                    <label className="field-label" htmlFor="review-remarks">
                      Remarks <span className="font-normal text-danger-text">(required to reject or request a correction)</span>
                    </label>
                    <textarea
                      id="review-remarks"
                      className="field resize-none text-xs leading-relaxed"
                      rows={4}
                      maxLength={1000}
                      placeholder="Validation feedback, rejection reasons or correction instructions…"
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                    />
                    <div className="mt-4 grid grid-cols-3 gap-2">
                      <button type="button" data-testid="decision-reject" className="btn-danger py-2 text-xs font-bold" disabled={busy} onClick={() => decide('reject')}>Reject</button>
                      <button type="button" data-testid="decision-correction" className="btn-secondary border-orange-300 py-2 text-xs font-bold text-flame-text hover:bg-orange-50" disabled={busy} onClick={() => decide('correction')}>Correction</button>
                      <button type="button" data-testid="decision-approve" className="btn-success py-2 text-xs font-bold" disabled={busy} onClick={() => decide('approve')}>{busy ? 'Saving…' : 'Approve'}</button>
                    </div>
                    <p className="mt-3 text-center text-[11px] text-ink-secondary">Your decision is saved together with an audit entry for version {activity.version}.</p>
                  </>
                )}
              </section>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div className="min-w-0">
      <p className="field-label">{label}</p>
      <p className="break-words text-xs font-bold text-ink-strong [overflow-wrap:anywhere]">{value}</p>
    </div>
  );
}

function Signal({ ok, warn, text }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
          warn
            ? 'bg-amber-100 text-warn-text'
            : ok
            ? 'bg-emerald-100 text-success-text'
            : 'bg-slate-200 text-ink-secondary'
        }`}
      >
        {warn ? '!' : ok ? '✓' : '—'}
      </span>
      <span className="text-ink font-medium">{text}</span>
    </div>
  );
}
