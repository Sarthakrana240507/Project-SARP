import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Avatar from '@/components/Avatar';
import ThemeSelector from '@/components/ThemeSelector';

/** The avatar button in the navbar: opens a small menu with the profile link, the appearance chooser and sign out. */
export default function ProfileMenu({ user, children, size = 36, testId = 'nav-avatar', onSignOut }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const router = useRouter();

  useEffect(() => { setOpen(false); }, [router.asPath]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="relative" ref={box}>
      <button
        type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu"
        data-testid={`${testId}-menu-button`}
        className="flex items-center gap-2.5 rounded-xl p-0.5 text-right transition hover:bg-surface-alt focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        {children}
        <Avatar user={user} size={size} testId={testId} />
      </button>
      {open && (
        <div role="menu" data-testid="profile-menu" className="fixed inset-x-4 top-16 z-50 animate-fade-in rounded-2xl border border-line bg-surface p-3 shadow-modal sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-72">
          <div className="flex items-center gap-3 border-b border-line-soft pb-3">
            <Avatar user={user} size={40} testId={`${testId}-menu-avatar`} />
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-ink-strong">{user.name}</p>
              <p className="truncate text-[11px] text-ink-secondary">{user.email}</p>
            </div>
          </div>
          <Link href="/profile" role="menuitem" data-testid="menu-profile" className="mt-2 flex items-center rounded-xl px-2.5 py-2 text-xs font-semibold text-ink hover:bg-surface-alt">
            My profile &amp; security
          </Link>
          <div className="mt-1 rounded-xl px-2.5 py-2">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-secondary">Appearance</p>
            <ThemeSelector testId="menu-theme" className="w-full justify-between [&>button]:flex-1" />
          </div>
          <button type="button" role="menuitem" data-testid="menu-signout" onClick={onSignOut} className="mt-1 flex w-full items-center rounded-xl px-2.5 py-2 text-left text-xs font-semibold text-danger-text hover:bg-danger-soft">
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
