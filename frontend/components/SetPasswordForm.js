import { useEffect, useState } from 'react';
import Link from 'next/link';
import AuthShell, { AuthCard, Notice } from '@/components/AuthShell';
import { getTokenInfo, activateAccount, resetPassword, passwordProblem } from '@/lib/api';

// Used by /activate and /reset-password. The one-time token arrives in the URL fragment
// (#token=...). It is read once, kept only in memory, and removed from the address bar.
export default function SetPasswordForm({ mode }) {
  const isReset = mode === 'reset';
  const [state, setState] = useState('loading'); // loading | ready | invalid | done
  const [token, setToken] = useState('');
  const [info, setInfo] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    window.history.replaceState(null, '', window.location.pathname); // drop the secret from the address bar
    if (!t) { setState('invalid'); return; }
    setToken(t);
    getTokenInfo(t)
      .then((data) => {
        if ((data.purpose === 'PASSWORD_RESET') !== isReset) throw new Error('wrong link type');
        setInfo(data);
        setState('ready');
      })
      .catch(() => setState('invalid'));
  }, [isReset]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    if (password !== confirm) return setError('The two passwords do not match');
    setBusy(true);
    try {
      await (isReset ? resetPassword : activateAccount)(token, password);
      setToken('');
      setState('done');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const title = isReset ? 'Choose a new password' : 'Activate your account';

  if (state === 'loading') return <AuthShell><AuthCard><p className="text-sm text-ink-secondary">Checking your link…</p></AuthCard></AuthShell>;

  if (state === 'invalid') {
    return (
      <AuthShell footer={<Link href="/login" className="font-bold text-brand-text hover:underline">Back to sign in</Link>}><AuthCard>
        <p className="eyebrow">{isReset ? 'Password reset' : 'Account activation'}</p>
        <h1 className="page-title">This link can&apos;t be used</h1>
        <Notice>This link is invalid, has expired, or was already used. Ask your administrator for a new one.</Notice>
        {!isReset && (
          <p className="mt-4 text-xs text-ink-secondary">
            If you are a student you can also <Link href="/register" className="font-bold text-brand-text hover:underline">request activation</Link> with your Student ID.
          </p>
        )}
      </AuthCard></AuthShell>
    );
  }

  if (state === 'done') {
    return (
      <AuthShell><AuthCard>
        <p className="eyebrow">{isReset ? 'Password reset' : 'Account activation'}</p>
        <h1 className="page-title">{isReset ? 'Password updated' : 'Your account is active'}</h1>
        <Notice kind="success">{isReset ? 'You can now sign in with your new password.' : 'Your password is set. You can now sign in.'}</Notice>
        <Link href="/login" className="btn-primary mt-6 block w-full py-3 text-center font-bold">Go to sign in</Link>
      </AuthCard></AuthShell>
    );
  }

  return (
    <AuthShell><AuthCard>
      <p className="eyebrow">{isReset ? 'Password reset' : 'Account activation'}</p>
      <h1 className="page-title">{title}</h1>
      <p className="page-subtitle">
        {info.name} · {info.email}
      </p>
      {error && <Notice>{error}</Notice>}
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label className="field-label" htmlFor="pw">New password</label>
          <input id="pw" className="field" type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <p className="mt-1.5 text-[11px] text-ink-secondary">At least 8 characters, with a letter and a number.</p>
        </div>
        <div>
          <label className="field-label" htmlFor="pw2">Confirm password</label>
          <input id="pw2" className="field" type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-body">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password
        </label>
        <button type="submit" className="btn-primary w-full py-3 font-bold" disabled={busy}>
          {busy ? 'Saving…' : isReset ? 'Update password' : 'Activate account'}
        </button>
      </form>
    </AuthCard></AuthShell>
  );
}
