import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import StatusBadge from '@/components/StatusBadge';
import { apiFetch, getToken, getUser, downloadPortfolioPdf } from '@/lib/api';

const categoryLabel = (c = '') => c.charAt(0).toUpperCase() + c.slice(1);

const categoryColors = {
  hackathon: 'bg-brand-soft text-brand-text border-brand-line',
  certification: 'bg-violet-soft text-violet-text border-violet-line',
  workshop: 'bg-accent-soft text-accent-text border-accent-line',
  sports: 'bg-warn-soft text-warn-text border-warn-line',
  internship: 'bg-success-soft text-success-text border-success-line',
  publication: 'bg-pink-soft text-pink-text border-pink-line',
  volunteering: 'bg-flame-soft text-flame-text border-flame-line',
};

export default function Portfolio() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [portfolioStudent, setPortfolioStudent] = useState(null);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const token = getToken();
    const u = getUser();
    if (!token || !u) {
      router.replace('/login');
      return;
    }
    setUser(u);

    const targetId = router.query.studentId ? Number(router.query.studentId) : u.id;

    if (u.role === 'student' && targetId !== u.id) {
      setError('Students can only view their own verified portfolio.');
      setLoading(false);
      return;
    }

    loadPortfolio(targetId, u);
  }, [router.isReady, router.query.studentId, router]);

  const loadPortfolio = async (studentId, currentUser) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/portfolio/${studentId}/data`);
      setPortfolioStudent(res.student);
      setActivities(res.activities || []);
      setError('');
    } catch (e) {
      if (currentUser?.role === 'student') {
        try {
          const mine = await apiFetch('/activities/mine?status=approved&limit=50');
          setActivities(mine.activities);
          setPortfolioStudent(currentUser);
          setError('');
        } catch (mineErr) {
          setError(mineErr.message);
        }
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const verified = activities.filter((a) => a.status === 'approved');

  const countsByCategory = useMemo(() => {
    return verified.reduce((acc, a) => {
      acc[a.category] = (acc[a.category] || 0) + 1;
      return acc;
    }, {});
  }, [verified]);

  const handleDownloadPdf = async () => {
    const targetStudent = portfolioStudent || user;
    if (!targetStudent) return;
    setDownloading(true);
    try {
      await downloadPortfolioPdf(targetStudent.id, targetStudent.name);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  };

  const displayStudent = portfolioStudent || user;

  return (
    <div className="app-shell">
      <main className="page-wrap">
        {/* Top Header */}
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div>
            <p className="eyebrow">Academic Credential</p>
            <h1 className="page-title">Verified Achievement Portfolio</h1>
            <p className="page-subtitle">
              Official institutional record of extracurricular and co-curricular achievements verified through the SARP faculty workflow.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="btn-primary"
              onClick={handleDownloadPdf}
              disabled={verified.length === 0 || downloading}
            >
              <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {downloading ? 'Compiling Official PDF…' : 'Download Portfolio PDF'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-5 rounded-xl border border-rose-200 bg-danger-soft p-4 text-xs font-semibold text-danger-text">
            {error}
          </div>
        )}

        {/* Portfolio Document Container */}
        <section className="card mt-7 overflow-hidden">
          {/* Institutional Header Banner */}
          <div className="relative overflow-hidden bg-gradient-to-r from-hero-from via-hero-via to-hero-from p-7 text-white sm:p-9 shadow-inner">
            <div className="absolute top-0 right-0 -mt-8 -mr-8 h-48 w-48 rounded-full bg-white/10 pointer-events-none"></div>
            <div className="relative z-10 flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
              <div>
                <div className="flex items-center gap-2">
                  <span className="flex h-5 items-center rounded bg-black/25 px-2 text-[10px] font-bold uppercase tracking-wider text-white">
                    Official Document
                  </span>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-white">
                    SARP · Student Activity Portfolio
                  </p>
                </div>
                <h2 className="mt-3 text-3xl font-bold tracking-tight text-white">{displayStudent?.name || 'Student Portfolio'}</h2>
                <p className="mt-1 text-xs text-white">
                  {displayStudent?.department || 'Department of Computer Science'} · {displayStudent?.email}
                </p>
              </div>

              <div className="rounded-2xl border border-white/20 bg-white/10 px-6 py-4 backdrop-blur-md">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-white">
                  Verified Achievements
                </p>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-white">{verified.length}</span>
                  <span className="text-xs text-white">✓ Confirmed</span>
                </div>
              </div>
            </div>
          </div>

          {/* Category breakdown bar */}
          <div className="grid gap-4 border-b border-line bg-surface-alt p-6 sm:grid-cols-4">
            {Object.entries(countsByCategory).length > 0 ? (
              Object.entries(countsByCategory).map(([category, count]) => (
                <div key={category} className="rounded-xl border border-line bg-surface p-4 shadow-subtle hover:border-brand/40 transition-colors">
                  <p className="text-2xl font-bold text-ink-strong">{count}</p>
                  <p className="mt-1 text-xs font-bold uppercase tracking-wider text-ink-secondary">
                    {categoryLabel(category)}
                  </p>
                </div>
              ))
            ) : (
              <div className="sm:col-span-4 py-4 text-center text-xs font-semibold text-ink-secondary">
                Category breakdown will appear here once faculty approves your activity submissions.
              </div>
            )}
          </div>

          {/* List of Verified Achievements */}
          {loading ? (
            <div className="p-12 text-center text-xs font-semibold text-ink-secondary">
              <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-navy border-t-transparent"></div>
              <p className="mt-2">Loading verified portfolio records…</p>
            </div>
          ) : verified.length === 0 ? (
            <div className="p-14 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-2xl text-brand-text">
                📜
              </div>
              <p className="mt-3.5 font-bold text-ink-strong">No Verified Achievements on Record Yet</p>
              <p className="mt-1 text-xs text-ink-secondary max-w-sm mx-auto">
                Only records reviewed and approved through the faculty review workflow appear in your official portfolio.
              </p>
              {user?.role === 'student' && (
                <Link href="/dashboard" className="btn-secondary mt-5 text-xs font-bold">
                  Go to Dashboard to Submit Activities →
                </Link>
              )}
            </div>
          ) : (
            <div className="divide-y divide-line-soft">
              {verified.map((a, index) => {
                const catClass = categoryColors[a.category] || 'bg-slate-100 text-slate-700 border-slate-200';
                return (
                  <div
                    key={a.id}
                    className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between transition-colors hover:bg-surface-alt"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex h-5 items-center justify-center rounded-md bg-brand-soft px-1.5 text-[10px] font-bold text-brand-text">
                          #{String(index + 1).padStart(2, '0')}
                        </span>
                        <h3 className="font-bold text-ink-strong text-sm">{a.title}</h3>
                        <span
                          className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${catClass}`}
                        >
                          {categoryLabel(a.category)}
                        </span>
                        <StatusBadge status="approved" />
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-secondary">
                        <span>
                          Verified on {a.reviewed_at ? new Date(a.reviewed_at).toLocaleDateString() : 'Official'}
                        </span>
                        {a.reviewer_name && (
                          <>
                            <span>•</span>
                            <span className="font-semibold text-ink">Verified by {a.reviewer_name}</span>
                          </>
                        )}
                        {a.proof_original_name && (
                          <>
                            <span>•</span>
                            <span className="truncate max-w-[200px]">Evidence: {a.proof_original_name}</span>
                          </>
                        )}
                      </div>

                      {a.description && (
                        <p className="mt-2 text-xs leading-relaxed text-ink-secondary bg-surface-alt p-2.5 rounded-xl border border-line-soft">
                          {a.description}
                        </p>
                      )}

                      {a.file_hash && (
                        <div className="mt-2 flex items-center gap-2 text-[10px] text-ink-secondary">
                          <span className="font-semibold text-brand-text">SHA-256 Digest:</span>
                          <code className="font-mono text-ink-secondary bg-slate-100 px-1.5 py-0.5 rounded truncate max-w-sm">
                            {a.file_hash}
                          </code>
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2 pt-2 sm:pt-0">
                      <Link href={`/activity/${a.id}`} className="btn-secondary py-1.5 text-xs font-bold">
                        Inspect Record →
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
