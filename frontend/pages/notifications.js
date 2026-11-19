import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getUser, getNotifications, markNotificationRead, markAllNotificationsRead } from '@/lib/api';
import { safeInAppLink, TYPE_STYLE, formatWhen } from '@/lib/notifications';

const PAGE_SIZE = 15;

export default function NotificationsPage() {
  const router = useRouter();
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ notifications: [], unread_count: 0, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = useRef(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await getNotifications({ filter, page, limit: PAGE_SIZE }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filter, page]);

  useEffect(() => {
    if (!getUser()) { router.push('/login'); return; }
    ready.current = true;
    load();
  }, [router, load]);

  const open = async (n) => {
    if (!n.is_read) {
      try { await markNotificationRead(n.id); } catch (err) { setError(err.message); return; }
    }
    const target = safeInAppLink(n.link);
    if (target) router.push(target); else load();
  };

  const markOne = async (n) => {
    try { await markNotificationRead(n.id); await load(); } catch (err) { setError(err.message); }
  };

  const markAll = async () => {
    setBusy(true);
    try { await markAllNotificationsRead(); await load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const changeFilter = (f) => { setFilter(f); setPage(1); setLoading(true); };

  return (
    <>
      <Head><title>SARP — Notifications</title></Head>
      <div className="min-h-screen bg-canvas">
        <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Inbox</p>
              <h1 className="text-2xl font-extrabold text-ink-strong">Notifications</h1>
              <p className="mt-1 text-xs text-ink-secondary" data-testid="notif-summary">
                {data.unread_count > 0 ? `${data.unread_count} unread` : 'You are all caught up'} · {data.total} {filter === 'unread' ? 'unread shown' : 'total'}
              </p>
            </div>
            <button type="button" className="btn-secondary" onClick={markAll} disabled={busy || data.unread_count === 0} data-testid="mark-all-read">
              Mark all as read
            </button>
          </div>

          <div className="mb-4 flex gap-2" role="tablist" aria-label="Notification filter">
            {[['all', 'All'], ['unread', 'Unread']].map(([key, label]) => (
              <button
                key={key} type="button" role="tab" aria-selected={filter === key} data-testid={`filter-${key}`}
                onClick={() => changeFilter(key)}
                className={`rounded-xl border px-3.5 py-1.5 text-xs font-semibold transition ${filter === key ? 'border-brand bg-brand-soft text-ink-strong' : 'border-line bg-surface text-ink-secondary hover:bg-canvas'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {error && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-danger-text" role="alert">{error}</div>}

          <div className="card divide-y divide-line overflow-hidden" data-testid="notif-list">
            {loading ? (
              <p className="py-14 text-center text-sm text-ink-secondary">Loading notifications…</p>
            ) : data.notifications.length === 0 ? (
              <p className="py-14 text-center text-sm text-ink-secondary" data-testid="notif-empty">
                {filter === 'unread' ? 'No unread notifications.' : 'No notifications yet. Updates about your activities and account will appear here.'}
              </p>
            ) : data.notifications.map((n) => {
              const style = TYPE_STYLE[n.type] || TYPE_STYLE.info;
              const target = safeInAppLink(n.link);
              return (
                <div key={n.id} data-testid="notif-row" data-unread={!n.is_read} className={`flex items-start gap-3 px-4 py-3.5 ${n.is_read ? 'bg-surface' : 'bg-brand-soft/60'}`}>
                  <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${n.is_read ? 'bg-line' : style.dot}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-sm text-ink [overflow-wrap:anywhere] ${n.is_read ? 'font-semibold' : 'font-bold'}`}>{n.title}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${style.chip}`}>{style.label}</span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-ink-secondary [overflow-wrap:anywhere]">{n.message}</p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-secondary">
                      <span>{formatWhen(n.created_at)}</span>
                      {target && <button type="button" onClick={() => open(n)} className="font-semibold text-brand-text hover:text-ink-strong" data-testid="notif-open">Open</button>}
                      {!n.is_read && <button type="button" onClick={() => markOne(n)} className="font-semibold text-brand-text hover:text-ink-strong" data-testid="notif-mark">Mark as read</button>}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {data.pages > 1 && (
            <div className="mt-4 flex items-center justify-between text-xs text-ink-secondary" data-testid="notif-pagination">
              <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <span>Page {data.page} of {data.pages}</span>
              <button type="button" className="btn-secondary" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          )}
          <p className="mt-6 text-center text-[11px] text-ink-secondary">Notifications are kept for your records and are visible only to you. <Link href="/profile" className="font-semibold text-brand-text">Account</Link></p>
        </main>
      </div>
    </>
  );
}
