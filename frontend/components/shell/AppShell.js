import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { getUser, logout, getRoleHome } from '@/lib/api';
import BrandMark from '@/components/BrandMark';
import ProfileMenu from '@/components/ProfileMenu';
import Avatar from '@/components/Avatar';
import Icon from './icons';
import NotificationBell from './NotificationBell';

// Pages that live inside the signed-in shell (sidebar + top bar). Login, activation and password pages stay public.
export const SHELL_ROUTES = ['/dashboard', '/faculty', '/admin', '/analytics', '/notifications', '/portfolio', '/profile', '/support', '/activity'];
export const inShell = (pathname) => SHELL_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

const ADMIN_TABS = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'users', label: 'Users', icon: 'users' },
  { id: 'import', label: 'Student import', icon: 'upload' },
  { id: 'faculty', label: 'Faculty', icon: 'badge' },
  { id: 'administrators', label: 'Administrators', icon: 'shield', superOnly: true },
  { id: 'academic', label: 'Academic setup', icon: 'academic' },
  { id: 'support', label: 'Support tickets', icon: 'ticket' },
  { id: 'audit', label: 'Audit log', icon: 'clipboard' },
];
export const ADMIN_TAB_IDS = ADMIN_TABS.map((t) => t.id);

const COMMON = [
  { id: 'notifications', href: '/notifications', label: 'Notifications', icon: 'bell' },
  { id: 'profile', href: '/profile', label: 'Profile & settings', icon: 'user' },
  { id: 'support', href: '/support', label: 'Contact & support', icon: 'lifebuoy' },
];
// Each role gets its own navigation: the entries differ, not just the labels.
const NAV = {
  student: [
    { id: 'activities', href: '/dashboard', label: 'My activities', icon: 'grid', match: ['/dashboard', '/activity'] },
    { id: 'portfolio', href: '/portfolio', label: 'Verified portfolio', icon: 'document' },
    ...COMMON,
  ],
  faculty: [
    { id: 'verification', href: '/faculty', label: 'Verification center', icon: 'badge' },
    { id: 'analytics', href: '/analytics', label: 'Analytics & reports', icon: 'chart' },
    ...COMMON,
  ],
  admin: [
    { id: 'verification', href: '/faculty', label: 'Verification queue', icon: 'badge' },
    { id: 'analytics', href: '/analytics', label: 'Analytics & reports', icon: 'chart' },
    ...COMMON,
  ],
};
const ROLE_LABEL = { student: 'Student', faculty: 'Faculty', admin: 'Administrator' };

export default function AppShell({ children }) {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [open, setOpen] = useState(false); // phone drawer

  useEffect(() => {
    setUser(getUser());
    setOpen(false);
  }, [router.asPath]);
  useEffect(() => { // the profile page announces name / photo changes
    const refresh = () => setUser(getUser());
    window.addEventListener('sarp:user', refresh);
    return () => window.removeEventListener('sarp:user', refresh);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);

  const signOut = () => { logout(); router.push('/login'); };
  const role = user?.role || 'student';
  const path = router.pathname;
  const tab = ADMIN_TABS.some((t) => t.id === router.query.tab) ? router.query.tab : 'overview';
  const onAdmin = path === '/admin';
  const isActive = (item) => (item.match || [item.href]).some((m) => path === m || path.startsWith(`${m}/`));
  const items = NAV[role] || NAV.student;
  const current = (role === 'admin' && onAdmin ? ADMIN_TABS.find((t) => t.id === tab)?.label && `Administration · ${ADMIN_TABS.find((t) => t.id === tab).label}` : null)
    || [...items, { href: '/admin', label: 'Administration' }].find((i) => isActive(i))?.label || 'SARP';

  const linkCls = (active) => `flex items-center gap-3 rounded-xl px-3 py-2 text-[13px] font-semibold transition ${active ? 'bg-brand-soft text-brand-text' : 'text-ink-secondary hover:bg-surface-sub hover:text-ink-strong'}`;
  const nav = (
    <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto px-3 py-4" data-testid="sidebar-nav">
      {role === 'admin' && (
        <div className="mb-3">
          <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">Administration</p>
          {ADMIN_TABS.filter((t) => !t.superOnly || user?.is_super_admin).map((t) => {
            const active = onAdmin && tab === t.id;
            return (
              <Link key={t.id} href={{ pathname: '/admin', query: { tab: t.id } }} data-testid={`nav-admin-${t.id}`} aria-current={active ? 'page' : undefined} className={linkCls(active)}>
                <Icon name={t.icon} />{t.label}
              </Link>
            );
          })}
          <p className="px-3 pb-1.5 pt-4 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">Workspace</p>
        </div>
      )}
      {items.map((i) => {
        const active = isActive(i);
        return (
          <Link key={i.id} href={i.href} data-testid={`nav-${i.id}`} aria-current={active ? 'page' : undefined} className={linkCls(active)}>
            <Icon name={i.icon} />{i.label}
          </Link>
        );
      })}
    </nav>
  );
  const panel = (
    <>
      <div className="flex h-16 shrink-0 items-center border-b border-line px-5">
        <Link href={getRoleHome(role)} aria-label="SARP home"><BrandMark size={36} subtitle={false} /></Link>
      </div>
      {user ? nav : <div className="flex-1" />}
      {user && (
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2.5 px-2 pb-2">
            <Avatar user={user} size={32} testId="sidebar-avatar" />
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-ink-strong">{user.name}</p>
              <p className="truncate text-[11px] text-ink-secondary">{ROLE_LABEL[role] || role}{user.department ? ` · ${user.department}` : ''}</p>
            </div>
          </div>
          <button type="button" onClick={signOut} data-testid="sidebar-signout" className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[13px] font-semibold text-ink-secondary transition hover:bg-danger-soft hover:text-danger-text">
            <Icon name="logout" />Sign out
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className="min-h-screen bg-canvas">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-surface lg:flex" data-testid="sidebar">{panel}</aside>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" data-testid="sidebar-drawer">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] animate-fade-in flex-col bg-surface shadow-modal">{panel}</aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur-md sm:px-6" data-testid="topbar">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-surface text-ink-secondary lg:hidden" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)} data-testid="menu-open">
              <Icon name="menu" />
            </button>
            <h2 className="truncate text-sm font-bold text-ink-strong" data-testid="topbar-title">{current}</h2>
          </div>
          {user && (
            <div className="flex items-center gap-3">
              <NotificationBell user={user} />
              <ProfileMenu user={user} size={34} testId="nav-avatar" onSignOut={signOut}>
                <span className="hidden text-right sm:block">
                  <span className="block max-w-[180px] truncate text-xs font-bold text-ink">{user.name}</span>
                  <span className="block text-[11px] text-ink-secondary">{ROLE_LABEL[role] || role}</span>
                </span>
              </ProfileMenu>
            </div>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}
