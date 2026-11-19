import Link from 'next/link';
import ThemeSelector from '@/components/ThemeSelector';
import BrandMark from '@/components/BrandMark';

// Shared frame for the public account pages (sign-in, activate, reset, forgot password, register).
export default function AuthShell({ children, footer, wide = false }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-6 sm:px-8">
        <Link href="/login" aria-label="SARP sign-in"><BrandMark /></Link>
        <ThemeSelector compact testId="auth-theme" />
      </header>
      <main className={`mx-auto w-full px-5 pb-12 pt-4 sm:pt-10 ${wide ? 'max-w-4xl' : 'max-w-md'}`}>
        {children}
        {footer && <p className="mt-6 text-center text-xs font-medium text-ink-secondary">{footer}</p>}
      </main>
    </div>
  );
}

/** The white card used by the single-form pages. */
export function AuthCard({ children }) {
  return <div className="card card-pad shadow-card">{children}</div>;
}

export function Notice({ kind = 'error', children }) {
  const styles = {
    error: 'border-rose-200 bg-danger-soft text-danger-text',
    success: 'border-emerald-200 bg-success-soft text-emerald-800',
    info: 'border-brand-line bg-brand-soft text-ink',
  };
  return <div role={kind === 'error' ? 'alert' : 'status'} className={`mt-5 rounded-xl border p-3.5 text-xs font-semibold ${styles[kind]}`}>{children}</div>;
}
