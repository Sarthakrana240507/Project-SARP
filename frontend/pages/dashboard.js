import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import StatusBadge from '@/components/StatusBadge';
import ActivityForm from '@/components/ActivityForm';
import { getToken, getUser, getRoleHome, downloadPortfolioPdf, submitDraft, getActivities, getActivity, getActivityOptions } from '@/lib/api';

const categoryColors = {
  hackathon: 'bg-brand-soft text-brand-text border-brand-line',
  certification: 'bg-violet-soft text-violet-text border-violet-line',
  workshop: 'bg-accent-soft text-accent-text border-accent-line',
  sports: 'bg-warn-soft text-warn-text border-warn-line',
  internship: 'bg-success-soft text-success-text border-success-line',
  publication: 'bg-pink-soft text-pink-text border-pink-line',
  volunteering: 'bg-flame-soft text-flame-text border-flame-line',
};

const categoryLabel = (c = '') => (c ? c.charAt(0).toUpperCase() + c.slice(1) : 'No category');

const PAGE_SIZE = 10;
const DEFAULT_FILTERS = { search: '', status: 'all', category: 'all', academic_session: 'all', semester: 'all', date_from: '', date_to: '', sort: 'newest', page: 1 };
const EMPTY_COUNTS = { total: 0, draft: 0, pending: 0, approved: 0, rejected: 0, correction_requested: 0 };

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [data, setData] = useState({ activities: [], total: 0, pages: 1, counts: EMPTY_COUNTS });
  const [options, setOptions] = useState({ categories: [], academic_years: [], semesters: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [search, setSearch] = useState(''); // what is typed; applied to the query after a short pause
  const [toast, setToast] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [editingDraft, setEditingDraft] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const requestId = useRef(0);
  const formRef = useRef(null);

  useEffect(() => {
    const token = getToken();
    const u = getUser();
    if (!token || !u) {
      router.replace('/login');
      return;
    }
    if (u.role !== 'student') {
      router.replace(getRoleHome(u.role));
      return;
    }
    setUser(u);
    getActivityOptions().then(setOptions).catch(() => {});
  }, [router]);

  // Every filter is sent to the server; the page never filters records itself.
  const loadActivities = useCallback(async () => {
    const id = ++requestId.current; // ignore answers that arrive after a newer request
    setLoading(true);
    try {
      const d = await getActivities({ ...filters, limit: PAGE_SIZE });
      if (id !== requestId.current) return;
      if (d.activities.length === 0 && d.total > 0 && filters.page > d.pages) {
        setFilters((f) => ({ ...f, page: d.pages })); // e.g. the last item on the last page was removed
        return;
      }
      setData(d);
      setError('');
    } catch (e) {
      if (id === requestId.current) setError(e.message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [filters]);
  useEffect(() => { if (user) loadActivities(); }, [user, loadActivities]);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.search === search.trim() ? f : { ...f, search: search.trim(), page: 1 })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value, page: 1 }));
  const resetFilters = () => { setSearch(''); setFilters(DEFAULT_FILTERS); };
  const filtersActive = JSON.stringify({ ...filters, page: 1 }) !== JSON.stringify(DEFAULT_FILTERS);

  const stats = {
    total: data.counts.total,
    pending: data.counts.pending,
    approved: data.counts.approved,
    correctionNeeded: data.counts.correction_requested,
    drafts: data.counts.draft,
    rejected: data.counts.rejected,
  };

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 5000); };

  const startEditing = useCallback((draft) => {
    setEditingDraft(draft);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }, []);
  const stopEditing = () => {
    setEditingDraft(null);
    setFormKey((k) => k + 1);
    if (router.query.edit) router.replace('/dashboard', undefined, { shallow: true });
  };

  // /dashboard?edit=ID opens that draft in the form (used by the activity page's "Edit draft" button).
  useEffect(() => {
    if (!router.isReady || !user || !router.query.edit) return;
    getActivity(router.query.edit).then((a) => { if (a.status === 'draft') startEditing(a); }).catch(() => {});
  }, [router.isReady, router.query.edit, user, startEditing]);

  const handleSubmitted = (result, kind) => {
    if (kind === 'draft') {
      flash('Draft saved.');
      if (editingDraft) setEditingDraft(result);
      else setFormKey((k) => k + 1);
    } else if (kind === 'discard') {
      flash('Draft discarded.');
      stopEditing();
    } else {
      flash(result.warning
        ? 'Activity submitted. Its proof file matches an earlier submission, so it was flagged for faculty to look at.'
        : 'Activity submitted and queued for faculty verification.');
      stopEditing();
    }
    loadActivities();
  };

  const handleSubmitDraftDirectly = async (e, draft) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await submitDraft(draft.id);
      flash('Draft submitted for verification.');
      loadActivities();
    } catch (err) {
      if (err.status === 400 && err.fields) { startEditing(draft); setError(`This draft is not complete yet: ${err.message}`); }
      else setError(err.message);
    }
  };

  const handleDownloadPdf = async () => {
    if (!user || stats.approved === 0) return;
    setDownloading(true);
    try {
      await downloadPortfolioPdf(user.id, user.name);
      setToast('Portfolio PDF downloaded successfully.');
      setTimeout(() => setToast(''), 4000);
    } catch (e) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  };

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-xs font-semibold text-ink-secondary">
        Loading student workspace…
      </div>
    );
  }

  return (
    <div className="app-shell">
      <main className="page-wrap">
        {/* Header Greeting Banner */}
        <div className="rounded-2xl border border-brand-line bg-gradient-to-r from-brand-soft via-surface to-accent-soft p-6 shadow-sm sm:p-7">
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-6 items-center rounded-md bg-navy px-2 text-[10px] font-bold uppercase tracking-wider text-white">
                  Student Portal
                </span>
                <span className="text-xs font-semibold text-ink-secondary">
                  {user.department || 'Department of Computer Science'}
                </span>
              </div>
              <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink-strong sm:text-3xl">
                Welcome back, {user.name.split(' ')[0]} 👋
              </h1>
              <p className="mt-1 text-xs text-ink-secondary sm:text-sm">
                Submit verifiable activity records, monitor faculty verification progress, and curate your official portfolio.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <Link href="/portfolio" className="btn-secondary">
                <svg className="h-3.5 w-3.5 text-brand-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                </svg>
                View Verified Portfolio
              </Link>
              <button
                className="btn-primary"
                disabled={stats.approved === 0 || downloading}
                onClick={handleDownloadPdf}
                title={stats.approved === 0 ? 'Requires at least one approved activity' : 'Download official PDF portfolio'}
              >
                <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {downloading ? 'Generating PDF…' : 'Download Portfolio PDF'}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-5 rounded-xl border border-rose-200 bg-danger-soft p-4 text-xs font-semibold text-danger-text">
            {error}
          </div>
        )}

        {/* 5 Summary KPI Cards */}
        <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard
            label="Total Submissions"
            value={stats.total}
            description="All platform records"
            icon={
              <svg className="h-5 w-5 text-brand-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            }
            iconBg="bg-brand-soft"
            accentBorder="border-l-brand"
          />

          <StatCard
            label="Pending Review"
            value={stats.pending}
            description="Awaiting faculty check"
            icon={
              <svg className="h-5 w-5 text-warn-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
            iconBg="bg-warn-soft"
            accentBorder="border-l-amber-500"
          />

          <StatCard
            label="Verified"
            value={stats.approved}
            description="In official portfolio"
            icon={
              <svg className="h-5 w-5 text-accent-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138z" />
              </svg>
            }
            iconBg="bg-accent-soft"
            accentBorder="border-l-accent"
          />

          <StatCard
            label="Corrections Needed"
            value={stats.correctionNeeded}
            description="Remarks from reviewer"
            icon={
              <svg className="h-5 w-5 text-flame-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            }
            iconBg="bg-flame-soft"
            accentBorder="border-l-orange-500"
          />

          <StatCard
            label="Saved Drafts"
            value={stats.drafts}
            description="Incomplete submissions"
            icon={
              <svg className="h-5 w-5 text-ink-body" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            }
            iconBg="bg-slate-100"
            accentBorder="border-l-slate-400"
          />
        </div>

        {/* Main Workspace Layout: Activity Record Table + Submission Form */}
        <div className="mt-7 grid gap-6 xl:grid-cols-[1fr_420px]">
          {/* Activity Record Table/List */}
          <section className="card overflow-hidden">
            <div className="border-b border-line bg-surface p-5 sm:p-6">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="section-title">My Activity Records</h2>
                      <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand-text">
                        {data.total} {filtersActive ? 'matching' : 'total'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-secondary">
                      Track real-time status and faculty verification remarks for all your submissions.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <span className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-ink-muted text-xs">
                        🔍
                      </span>
                      <input
                        className="field pl-8 max-w-[190px] text-xs py-1.5"
                        placeholder="Search records…"
                        value={search}
                        aria-label="Search records"
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {/* Filter Pills / Tabs */}
                <div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-3">
                  {[
                    { id: 'all', label: 'All Records', count: stats.total },
                    { id: 'pending', label: 'Pending Review', count: stats.pending },
                    { id: 'approved', label: 'Verified', count: stats.approved },
                    { id: 'correction_requested', label: 'Corrections Needed', count: stats.correctionNeeded },
                    { id: 'draft', label: 'Drafts', count: stats.drafts },
                    { id: 'rejected', label: 'Rejected', count: stats.rejected },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setFilter('status', tab.id)}
                      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                        filters.status === tab.id
                          ? 'bg-navy text-white shadow-xs'
                          : 'bg-surface-alt text-ink-secondary hover:bg-brand-soft hover:text-ink-strong'
                      }`}
                    >
                      <span>{tab.label}</span>
                      <span
                        className={`rounded-full px-1.5 py-0.2 text-[10px] font-bold ${
                          filters.status === tab.id ? 'bg-black/20 text-white' : 'bg-slate-200 text-slate-700'
                        }`}
                      >
                        {tab.count}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* More filters (all applied by the server) */}
            <div className="grid gap-2 border-b border-line-soft bg-surface-alt px-5 py-3 sm:grid-cols-2" data-testid="filter-bar">
              <select className="field py-1.5 text-xs" aria-label="Category" value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
                <option value="all">All categories</option>
                {options.categories.map((c) => <option key={c.name} value={c.name}>{c.display_name}</option>)}
              </select>
              <select className="field py-1.5 text-xs" aria-label="Academic year" value={filters.academic_session} onChange={(e) => setFilter('academic_session', e.target.value)}>
                <option value="all">All academic years</option>
                {options.academic_years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <select className="field py-1.5 text-xs" aria-label="Semester" value={filters.semester} onChange={(e) => setFilter('semester', e.target.value)}>
                <option value="all">All semesters</option>
                {options.semesters.map((n) => <option key={n} value={String(n)}>Semester {n}</option>)}
              </select>
              <select className="field py-1.5 text-xs" aria-label="Sort order" value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)}>
                <option value="newest">Newest submitted</option>
                <option value="oldest">Oldest submitted</option>
                <option value="date_newest">Activity date: newest</option>
                <option value="date_oldest">Activity date: oldest</option>
              </select>
              <label className="flex items-center gap-2 text-[11px] font-semibold text-ink-secondary">
                From
                <input type="date" className="field py-1.5 text-xs" aria-label="Activity date from" value={filters.date_from} max={filters.date_to || undefined} onChange={(e) => setFilter('date_from', e.target.value)} />
              </label>
              <label className="flex items-center gap-2 text-[11px] font-semibold text-ink-secondary">
                To
                <input type="date" className="field py-1.5 text-xs" aria-label="Activity date to" value={filters.date_to} min={filters.date_from || undefined} onChange={(e) => setFilter('date_to', e.target.value)} />
              </label>
              <div className="flex items-center sm:col-span-2 lg:justify-end">
                <button type="button" onClick={resetFilters} disabled={!filtersActive && !search} className="btn-secondary px-3 py-1.5 text-[11px]" data-testid="reset-filters">
                  Reset filters
                </button>
              </div>
            </div>

            {loading ? (
              <div className="p-12 text-center text-xs font-semibold text-ink-secondary">
                <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-navy border-t-transparent"></div>
                <p className="mt-2">Loading your activity records…</p>
              </div>
            ) : data.activities.length === 0 ? (
              <div className="p-12 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-2xl text-brand-text">
                  📁
                </div>
                <p className="mt-3.5 font-bold text-ink-strong">
                  {filtersActive || search ? 'No matching records in this view' : 'No activity records submitted yet'}
                </p>
                <p className="mt-1 text-xs text-ink-secondary max-w-sm mx-auto">
                  {filtersActive || search
                    ? 'Try a different filter or search keyword, or reset the filters.'
                    : 'Submit your first extracurricular achievement proof using the form on the right.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-line-soft">
                {data.activities.map((a) => {
                  const catClass = categoryColors[a.category] || 'bg-slate-100 text-slate-700 border-slate-200';
                  return (
                    <Link
                      href={`/activity/${a.id}`}
                      key={a.id}
                      className="group flex flex-col gap-3 p-5 transition-all duration-150 hover:bg-surface-alt sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${catClass}`}
                          >
                            {categoryLabel(a.category)}
                          </span>
                          <h3 className="truncate font-bold text-ink-strong group-hover:text-brand-text transition-colors">
                            {a.title}
                          </h3>
                          <StatusBadge status={a.status} />
                          {a.is_duplicate && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-warn-soft px-2 py-0.5 text-[10px] font-bold text-warn-text">
                              ⚠ Duplicate flag
                            </span>
                          )}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-secondary">
                          {a.activity_date && <span>Activity date {new Date(`${a.activity_date}T00:00:00`).toLocaleDateString()}</span>}
                          {a.activity_date && <span>•</span>}
                          <span>
                            {a.status === 'draft' ? 'Draft saved' : 'Submitted'} on {new Date(a.created_at).toLocaleDateString()}
                          </span>
                          {a.version > 1 && (<><span>•</span><span className="font-semibold text-brand-text">Version {a.version}</span></>)}
                          {a.academic_session && (
                            <>
                              <span>•</span>
                              <span>Academic year {a.academic_session}</span>
                            </>
                          )}
                          {a.semester && (
                            <>
                              <span>•</span>
                              <span>Semester {a.semester}</span>
                            </>
                          )}
                          {a.reviewer_name && (
                            <>
                              <span>•</span>
                              <span className="font-medium text-ink">Reviewed by {a.reviewer_name}</span>
                            </>
                          )}
                          {a.proof_original_name && (
                            <>
                              <span>•</span>
                              <span className="truncate max-w-[200px]">📎 {a.proof_original_name}</span>
                            </>
                          )}
                        </div>

                        {a.status === 'correction_requested' && a.correction_notes && (
                          <div className="mt-2.5 rounded-xl border border-orange-200 bg-flame-soft p-2.5 text-xs text-orange-900">
                            <strong>Correction Needed:</strong> {a.correction_notes}
                            <span className="block mt-1 font-semibold text-flame-text underline">
                              Click to view feedback & resubmit corrections →
                            </span>
                          </div>
                        )}

                        {a.status === 'rejected' && a.review_remarks && (
                          <div className="mt-2.5 rounded-xl border border-rose-200 bg-danger-soft p-2.5 text-xs text-danger-text">
                            <strong>Faculty Feedback:</strong> {a.review_remarks}
                          </div>
                        )}

                        {a.status === 'approved' && a.review_remarks && (
                          <div className="mt-2 rounded-lg bg-success-soft p-2 text-[11px] text-success-text">
                            ✓ Verified: {a.review_remarks}
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {a.status === 'draft' && (
                          <>
                            <button
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); startEditing(a); }}
                              className="btn-secondary px-3 py-1 text-[11px] font-bold"
                              data-testid={`edit-draft-${a.id}`}
                            >
                              Edit
                            </button>
                            {a.has_proof && (
                              <button
                                onClick={(e) => handleSubmitDraftDirectly(e, a)}
                                className="btn-primary px-3 py-1 text-[11px] font-bold"
                                data-testid={`submit-draft-${a.id}`}
                              >
                                Submit
                              </button>
                            )}
                          </>
                        )}
                        <span className="text-xs font-bold text-brand-text opacity-0 group-hover:opacity-100 transition-opacity">
                          View details →
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}

            {data.total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 text-[11px] text-ink-secondary" data-testid="pagination">
                <span>
                  Showing {(filters.page - 1) * PAGE_SIZE + 1}–{Math.min(filters.page * PAGE_SIZE, data.total)} of {data.total}
                </span>
                <div className="flex items-center gap-2">
                  <button className="btn-secondary px-3 py-1.5 text-[11px]" disabled={filters.page <= 1 || loading} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}>Previous</button>
                  <span>Page {filters.page} of {data.pages}</span>
                  <button className="btn-secondary px-3 py-1.5 text-[11px]" disabled={filters.page >= data.pages || loading} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>Next</button>
                </div>
              </div>
            )}
          </section>

          {/* Submission Form Component */}
          <div ref={formRef}>
            <ActivityForm
              key={editingDraft ? `edit-${editingDraft.id}` : `new-${formKey}`}
              draft={editingDraft}
              onSubmitted={handleSubmitted}
              onCancel={stopEditing}
            />
          </div>
        </div>

        {/* Informational Architecture Pillars */}
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <FeatureCard
            icon="🔒"
            title="Proof-First Verification"
            text="Every submission requires valid digital evidence. Files are stored outside public web roots and accessed exclusively via JWT authorization."
          />
          <FeatureCard
            icon="⚡"
            title="Cryptographic SHA-256 Hashing"
            text="Deterministic SHA-256 hashes detect identical evidence bytes across institutional records, flagging collisions for faculty review."
          />
          <FeatureCard
            icon="📋"
            title="Complete Lifecycle & Audit Trail"
            text="From draft to verified achievement, every action creates an immutable audit record and in-app notification."
          />
        </div>
      </main>

      {toast && (
        <div className="toast">
          <span className="text-accent-text font-bold">✓</span>
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, description, icon, iconBg, accentBorder }) {
  return (
    <div className={`stat-card border-l-4 ${accentBorder}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-3xl font-bold tracking-tight text-ink-strong">{value}</p>
          <p className="mt-1 text-xs font-bold uppercase tracking-wider text-ink-secondary">{label}</p>
        </div>
        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${iconBg} shadow-xs`}>
          {icon}
        </div>
      </div>
      {description && <p className="mt-2 text-[11px] text-ink-secondary border-t border-line-soft pt-2">{description}</p>}
    </div>
  );
}

function FeatureCard({ icon, title, text }) {
  return (
    <div className="card p-5 hover:border-brand-line transition-colors">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-base">
        {icon}
      </div>
      <p className="mt-3 text-xs font-bold text-ink-strong">{title}</p>
      <p className="mt-1 text-[11px] leading-5 text-ink-secondary">{text}</p>
    </div>
  );
}
