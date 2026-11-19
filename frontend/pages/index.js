import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { getToken, getUser, getRoleHome } from '@/lib/api';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const token = getToken();
    const user = getUser();
    if (token && user) {
      router.replace(getRoleHome(user.role));
    } else {
      router.replace('/login');
    }
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas text-xs font-semibold text-ink-secondary">
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card">
        <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-navy text-sm font-bold text-white shadow-subtle">
          <span>S</span>
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-surface bg-accent"></span>
        </div>
        <div>
          <p className="font-bold text-ink-strong">SARP</p>
          <p className="text-[11px] text-ink-secondary">Routing to your academic workspace…</p>
        </div>
      </div>
    </div>
  );
}
