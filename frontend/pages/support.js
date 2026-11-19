import Head from 'next/head';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { getUser, createSupportTicket, getMySupportTickets } from '@/lib/api';
import { SUPPORT_EMAIL, CATEGORIES, STATUS_LABEL, STATUS_STYLE, LIMITS } from '@/lib/support';
import { formatWhen } from '@/lib/notifications';

const HISTORY_PAGE = 5;
const EMPTY = { category: '', subject: '', message: '' };

function StatusPill({ status }) {
  return <span className={`inline-block rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_STYLE[status] || ''}`}>{STATUS_LABEL[status] || status}</span>;
}

export default function SupportPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [name, setName] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null); // the ticket just created
  const [history, setHistory] = useState({ tickets: [], total: 0, pages: 1 });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null); // ticket_ref shown in full
  const [historyError, setHistoryError] = useState('');

  useEffect(() => {
    const u = getUser();
    if (!u) { router.replace('/login'); return; }
    setUser(u); setName(u.name || '');
  }, [router]);

  const loadHistory = useCallback(async () => {
    try { setHistory(await getMySupportTickets({ page, limit: HISTORY_PAGE })); setHistoryError(''); }
    catch (err) { setHistoryError(err.message); }
  }, [page]);
  useEffect(() => { if (user) loadHistory(); }, [user, loadHistory]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(''); setErrors({});
    try {
      const t = await createSupportTicket({ name, email: user.email, ...form });
      setSent(t); setForm(EMPTY); setPage(1); setOpen(t.ticket_ref);
      await loadHistory();
    } catch (err) {
      setErrors(err.fields || {});
      setFormError(err.message);
    } finally { setBusy(false); }
  };

  if (!user) return null;
  const fieldError = (k) => errors[k] && <p className="mt-1 text-[11px] font-semibold text-danger-text" role="alert">{errors[k]}</p>;

  return (
    <>
      <Head><title>SARP — Contact & Support</title></Head>
      <div className="min-h-screen bg-canvas">
        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <p className="eyebrow">Help</p>
          <h1 className="page-title">Contact &amp; Support</h1>

          <section className="card card-pad mt-6" data-testid="support-contact">
            <h2 className="section-title">SARP Support</h2>
            <p className="mt-1.5 text-xs text-ink-secondary sm:text-sm">
              Having trouble with your account, an activity or a document? Send a ticket below and an administrator will look into it. You can follow its progress on this page.
            </p>
            <p className="mt-3 text-xs sm:text-sm text-ink-body">
              {SUPPORT_EMAIL ? (
                <>Support email: <a className="font-bold text-brand-text underline" href={`mailto:${SUPPORT_EMAIL}`} data-testid="support-email">{SUPPORT_EMAIL}</a></>
              ) : (
                <span data-testid="support-email-missing">A support email address has not been set up for this installation. Please use the ticket form.</span>
              )}
            </p>
          </section>

          <div className="mt-6 grid gap-6 lg:grid-cols-5">
            <section className="card card-pad lg:col-span-3">
              <h2 className="section-title">Send a support ticket</h2>
              {sent && (
                <div className="mt-4 rounded-xl border border-success-line bg-success-soft p-4 text-xs text-success-text" role="status" data-testid="ticket-confirmation">
                  <p className="font-bold">Ticket received</p>
                  <p className="mt-1">Your ticket ID is <span className="font-mono font-bold" data-testid="ticket-ref">{sent.ticket_ref}</span>. Its status is shown in your ticket history.</p>
                </div>
              )}
              <form onSubmit={submit} className="mt-4 space-y-4" noValidate data-testid="ticket-form">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="field-label" htmlFor="t-name">Name</label>
                    <input id="t-name" className="field" value={name} maxLength={LIMITS.name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                    {fieldError('name')}
                  </div>
                  <div>
                    <label className="field-label" htmlFor="t-email">Registered email</label>
                    <input id="t-email" className="field bg-surface-alt text-ink-secondary" value={user.email} readOnly aria-readonly="true" />
                    {fieldError('email')}
                  </div>
                </div>
                <div>
                  <label className="field-label" htmlFor="t-category">Issue category</label>
                  <select id="t-category" className="field" value={form.category} onChange={set('category')}>
                    <option value="">Choose a category…</option>
                    {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                  {fieldError('category')}
                </div>
                <div>
                  <label className="field-label" htmlFor="t-subject">Subject</label>
                  <input id="t-subject" className="field" value={form.subject} maxLength={LIMITS.subject} onChange={set('subject')} placeholder="A short summary of the problem" />
                  {fieldError('subject')}
                </div>
                <div>
                  <label className="field-label" htmlFor="t-message">Message</label>
                  <textarea id="t-message" className="field min-h-[120px]" value={form.message} maxLength={LIMITS.message} onChange={set('message')} placeholder="What happened, and what did you expect?" />
                  <p className="mt-1 text-[11px] text-ink-muted">{form.message.length} / {LIMITS.message}</p>
                  {fieldError('message')}
                </div>
                {formError && !Object.keys(errors).length && <p className="text-xs font-semibold text-danger-text" role="alert" data-testid="ticket-error">{formError}</p>}
                <button type="submit" className="btn-primary" disabled={busy} data-testid="ticket-submit">{busy ? 'Sending…' : 'Submit ticket'}</button>
              </form>
            </section>

            <section className="card card-pad lg:col-span-2" data-testid="ticket-history">
              <h2 className="section-title">Your tickets</h2>
              {historyError && <p className="mt-3 text-xs font-semibold text-danger-text" role="alert">{historyError}</p>}
              {!historyError && history.tickets.length === 0 && <p className="mt-3 text-xs text-ink-secondary">You have not sent any tickets yet.</p>}
              <ul className="mt-3 space-y-2">
                {history.tickets.map((t) => (
                  <li key={t.ticket_ref} className="rounded-xl border border-line bg-surface-alt p-3" data-testid={`ticket-${t.ticket_ref}`}>
                    <button type="button" className="flex w-full items-start justify-between gap-2 text-left" onClick={() => setOpen(open === t.ticket_ref ? null : t.ticket_ref)} aria-expanded={open === t.ticket_ref}>
                      <span className="min-w-0">
                        <span className="block font-mono text-[11px] font-bold text-ink-secondary">{t.ticket_ref}</span>
                        <span className="block truncate text-xs font-bold text-ink-strong">{t.subject}</span>
                      </span>
                      <StatusPill status={t.status} />
                    </button>
                    {open === t.ticket_ref && (
                      <div className="mt-3 border-t border-line pt-3 text-xs text-ink-body">
                        <p className="text-[11px] text-ink-secondary">{t.category_label} · sent {formatWhen(t.created_at)}{t.resolved_at ? ` · resolved ${formatWhen(t.resolved_at)}` : ''}</p>
                        <p className="mt-2 whitespace-pre-wrap break-words">{t.message}</p>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {history.pages > 1 && (
                <div className="mt-3 flex items-center justify-between text-[11px] text-ink-secondary" data-testid="ticket-pagination">
                  <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
                  <span>Page {page} of {history.pages}</span>
                  <button type="button" className="btn-secondary" disabled={page >= history.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
                </div>
              )}
            </section>
          </div>
        </main>
      </div>
    </>
  );
}
