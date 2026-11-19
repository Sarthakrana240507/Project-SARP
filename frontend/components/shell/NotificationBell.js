import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { getNotifications, markNotificationRead, markAllNotificationsRead, getUnreadNotificationCount } from '@/lib/api';
import { safeInAppLink, TYPE_STYLE, formatWhen } from '@/lib/notifications';

/** The bell in the top bar: unread badge (refreshed once a minute while the tab is visible) and a short list of recent notifications. */
export default function NotificationBell({ user }) {
  const router = useRouter();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef(null);

  const fetchNotifs = async () => {
    try {
      const data = await getNotifications();
      if (data && data.notifications) {
        setNotifications(data.notifications);
        setUnreadCount(data.unread_count || 0);
      }
    } catch {
      // silently ignore if unauthenticated
    }
  };

  useEffect(() => { if (user) fetchNotifs(); }, [router.asPath, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the unread badge fresh: one light request a minute, only while the tab is visible and signed in.
  useEffect(() => {
    if (!user) return undefined;
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const data = await getUnreadNotificationCount();
        setUnreadCount(data.unread_count || 0);
      } catch {
        // ignore (e.g. signed out in another tab)
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [user]);

  // Click outside listener for notification popover
  useEffect(() => {
    function handleClickOutside(e) {
      if (notifRef.current && !notifRef.current.contains(e.target)) {
        setNotifOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch (err) {
      console.error(err);
    }
  };

  const handleNotificationClick = async (notif) => {
    if (!notif.is_read) {
      try {
        await markNotificationRead(notif.id);
        setNotifications((prev) =>
          prev.map((n) => (n.id === notif.id ? { ...n, is_read: true } : n))
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      } catch (err) {
        console.error(err);
      }
    }
    setNotifOpen(false);
    const target = safeInAppLink(notif.link);
    if (target) router.push(target);
  };

  return (
    <div className="relative" ref={notifRef}>
    <div className="relative" ref={notifRef}>
      <button
        type="button"
        onClick={() => {
          setNotifOpen(!notifOpen);
          if (!notifOpen) fetchNotifs();
        }}
        className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-surface text-brand-text shadow-xs transition-all duration-150 hover:bg-surface-alt hover:text-ink-strong"
        aria-label="Notifications"
        data-testid="bell"
      >
        <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unreadCount > 0 && (
          <span data-testid="bell-count" className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-solid-danger px-1 text-[9px] font-bold text-white shadow-xs">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {notifOpen && (
        <div data-testid="notif-popover" className="fixed inset-x-4 top-16 sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-96 rounded-2xl border border-line bg-surface p-3 shadow-xl z-50 animate-fade-in">
          <div className="flex items-center justify-between border-b border-line-soft pb-2.5 px-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-ink-strong">Notifications</span>
              {unreadCount > 0 && (
                <span className="rounded-full bg-danger-soft px-2 py-0.2 text-[10px] font-bold text-danger-text">
                  {unreadCount} new
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-[11px] font-semibold text-brand-text hover:text-ink-strong transition"
              >
                Mark all as read
              </button>
            )}
          </div>

          <div className="mt-2 max-h-72 overflow-y-auto divide-y divide-surface-alt">
            {notifications.length === 0 ? (
              <div className="py-6 text-center text-xs text-ink-secondary">
                No notifications yet
              </div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  data-testid="notif-item"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleNotificationClick(n); }}
                  onClick={() => handleNotificationClick(n)}
                  className={`group cursor-pointer rounded-xl p-2.5 transition ${
                    !n.is_read ? 'bg-brand-soft/50 hover:bg-brand-soft' : 'hover:bg-surface-alt'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-bold text-ink-strong">{n.title}</p>
                    {!n.is_read && (
                      <span className={`h-2 w-2 rounded-full shrink-0 mt-1 ${(TYPE_STYLE[n.type] || TYPE_STYLE.info).dot}`}></span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-secondary line-clamp-2 leading-relaxed">
                    {n.message}
                  </p>
                  <span className="mt-1 block text-[9px] font-medium text-ink-muted">
                    {formatWhen(n.created_at)}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="mt-2 border-t border-line-soft pt-2 text-center">
            <Link href="/notifications" onClick={() => setNotifOpen(false)} data-testid="view-all-notifications" className="text-[11px] font-semibold text-brand-text hover:text-ink-strong">
              View all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
