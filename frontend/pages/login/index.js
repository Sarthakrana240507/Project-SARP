import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import AuthShell from '@/components/AuthShell';
import Icon from '@/components/shell/icons';
import { getToken, getUser, getRoleHome } from '@/lib/api';
import { PORTALS } from '@/lib/portals';
import { SUPPORT_EMAIL } from '@/lib/support';

// Step 1 of signing in: choose the portal. Step 2 (login/[portal]) is the form for that portal.
export default function ChoosePortal() {
  const router = useRouter();
  useEffect(() => {
    const user = getUser();
    if (getToken() && user) router.replace(getRoleHome(user.role));
  }, [router]);
  const ended = router.query.session === 'ended';

  return (
    <>
      <Head><title>SARP — Sign in</title></Head>
      <AuthShell wide footer={SUPPORT_EMAIL && <>Trouble signing in? <a className="font-bold text-brand-text hover:underline" href={`mailto:${SUPPORT_EMAIL}`} data-testid="login-support-email">Contact support</a></>}>
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-ink-strong sm:text-3xl">Sign in to SARP</h1>
          <p className="mt-2 text-sm text-ink-secondary">Choose how you use the platform.</p>
        </div>
        {ended && <div role="status" className="mx-auto mt-6 max-w-md rounded-xl border border-amber-200 bg-warn-soft p-3 text-center text-xs font-semibold text-amber-800">Your session has ended. Please sign in again.</div>}

        <div className="mt-8 grid gap-4 sm:grid-cols-3" data-testid="portal-choices">
          {Object.values(PORTALS).map((p) => (
            <Link key={p.id} href={`/login/${p.id}`} data-testid={`portal-${p.id}`}
              className="group flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-card transition hover:-translate-y-0.5 hover:border-brand hover:shadow-cardHover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand">
              <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${p.tone}`}><Icon name={p.icon} className="h-6 w-6" /></span>
              <span className="mt-4 text-base font-bold text-ink-strong">{p.title}</span>
              <span className="mt-1.5 flex-1 text-xs leading-relaxed text-ink-secondary">{p.blurb}</span>
              <span className="mt-5 text-xs font-bold text-brand-text group-hover:underline">Continue →</span>
            </Link>
          ))}
        </div>

        <p className="mt-8 text-center text-xs font-medium text-ink-secondary">
          New student?{' '}
          <Link href="/register" className="font-bold text-brand-text hover:underline">Activate your account</Link>
        </p>
      </AuthShell>
    </>
  );
}
