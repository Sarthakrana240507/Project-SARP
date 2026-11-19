import { useState } from 'react';
import Link from 'next/link';
import AuthShell, { AuthCard, Notice } from '@/components/AuthShell';
import { forgotPassword } from '@/lib/api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      setResult(await forgotPassword(email));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell footer={<Link href="/login" className="font-bold text-brand-text hover:underline">Back to sign in</Link>}>
      <AuthCard>
      <p className="eyebrow">Password reset</p>
      <h1 className="page-title">Forgot your password?</h1>
      {error && <Notice>{error}</Notice>}
      {result ? (
        <Notice kind={result.delivery === 'EMAIL' ? 'success' : 'info'}>{result.message}</Notice>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="field-label" htmlFor="fp-email">Official email</label>
            <input id="fp-email" className="field" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <button type="submit" className="btn-primary w-full py-3 font-bold" disabled={busy}>{busy ? 'Please wait…' : 'Continue'}</button>
        </form>
      )}
    </AuthCard>
    </AuthShell>
  );
}
