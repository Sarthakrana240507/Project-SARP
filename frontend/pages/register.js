import { useState } from 'react';
import Link from 'next/link';
import AuthShell, { AuthCard, Notice } from '@/components/AuthShell';
import { requestActivation } from '@/lib/api';

// Verified self-registration: the details must match the roster the administrator imported.
export default function Register() {
  const [form, setForm] = useState({ student_id: '', email: '', name: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      setResult(await requestActivation(form));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell footer={<>Already activated? <Link href="/login" className="font-bold text-brand-text hover:underline">Sign in</Link></>}>
      <AuthCard>
      <p className="eyebrow">Student activation</p>
      <h1 className="page-title">Activate your account</h1>
      <p className="page-subtitle">Enter the details your college has on record.</p>
      {error && <Notice>{error}</Notice>}
      {result ? (
        <Notice kind={result.delivery === 'EMAIL' ? 'success' : 'info'}>{result.message}</Notice>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="field-label" htmlFor="r-id">Student ID</label>
            <input id="r-id" className="field" value={form.student_id} onChange={set('student_id')} required />
          </div>
          <div>
            <label className="field-label" htmlFor="r-email">Official email</label>
            <input id="r-email" className="field" type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
          </div>
          <div>
            <label className="field-label" htmlFor="r-name">Full name</label>
            <input id="r-name" className="field" autoComplete="name" value={form.name} onChange={set('name')} required />
          </div>
          <button type="submit" className="btn-primary w-full py-3 font-bold" disabled={busy}>{busy ? 'Checking…' : 'Request activation'}</button>
        </form>
      )}
    </AuthCard>
    </AuthShell>
  );
}
