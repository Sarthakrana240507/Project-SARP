import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import AuthShell, { AuthCard, Notice } from '@/components/AuthShell';
import { apiFetch, getToken, getUser, saveSession, getRoleHome } from '@/lib/api';
import { PORTALS } from '@/lib/portals';
import { SUPPORT_EMAIL } from '@/lib/support';

// Step 2 of signing in. The server checks the credentials AND that the account really belongs to this portal.
export default function PortalLogin() {
  const router = useRouter();
  const id = router.query.portal;
  const portal = PORTALS[id];
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!router.isReady) return;
    if (!portal) { router.replace('/login'); return; }
    const user = getUser();
    if (getToken() && user) router.replace(getRoleHome(user.role));
  }, [router, portal]);

  if (!portal) return null;
  const ended = router.query.session === 'ended';

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const data = await apiFetch('/auth/login', { method: 'POST', body: { ...form, portal: portal.id } });
      saveSession(data);
      router.push(getRoleHome(data.user?.role));
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <Head><title>{`SARP — ${portal.title}`}</title></Head>
      <AuthShell footer={SUPPORT_EMAIL && <>Trouble signing in? <a className="font-bold text-brand-text hover:underline" href={`mailto:${SUPPORT_EMAIL}`} data-testid="login-support-email">Contact support</a></>}>
        <AuthCard>
          <Link href="/login" className="text-[11px] font-bold text-brand-text hover:underline" data-testid="change-portal">← Choose a different sign-in</Link>
          <h1 className="page-title" data-testid="portal-title">{portal.title}</h1>
          <p className="page-subtitle">Sign in with your institutional email.</p>

          {ended && !error && <Notice kind="info">Your session has ended. Please sign in again.</Notice>}
          {error && <Notice>{error}</Notice>}

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="field-label" htmlFor="email">Institutional email</label>
              <input id="email" className="field" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div>
              <label className="field-label" htmlFor="password">Password</label>
              <input id="password" className="field" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
              <div className="mt-1.5 text-right">
                <Link href="/forgot-password" className="text-[11px] font-bold text-brand-text hover:underline">Forgot password?</Link>
              </div>
            </div>
            <button type="submit" className="btn-primary w-full py-3 font-bold" disabled={busy} data-testid="login-submit">{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>

          <p className="mt-6 text-center text-xs text-ink-secondary">
            {portal.id === 'student'
              ? <>First time here? <Link href="/register" className="font-bold text-brand-text hover:underline">Activate your account</Link></>
              : 'Accounts for this portal are created by the institution’s administrator.'}
          </p>
        </AuthCard>
      </AuthShell>
    </>
  );
}
