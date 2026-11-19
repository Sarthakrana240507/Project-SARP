import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import StatusBadge from '@/components/StatusBadge';
import {
  apiFetch,
  getToken,
  getUser,
  viewProofDocument,
  resubmitActivity,
  submitDraft,
  getActivityOptions,
  getActivityVersions,
  approveActivity,
  rejectActivity,
  requestCorrection,
} from '@/lib/api';

const categoryColors = {
  hackathon: 'bg-brand-soft text-brand-text border-brand-line',
  certification: 'bg-violet-soft text-violet-text border-violet-line',
  workshop: 'bg-accent-soft text-accent-text border-accent-line',
  sports: 'bg-warn-soft text-warn-text border-warn-line',
  internship: 'bg-success-soft text-success-text border-success-line',
  publication: 'bg-pink-soft text-pink-text border-pink-line',
  volunteering: 'bg-flame-soft text-flame-text border-flame-line',
};

export default function ActivityDetails() {
  const router = useRouter();
  const { id } = router.query;
  const fileInputRef = useRef(null);

  const [currentUser, setCurrentUser] = useState(null);
  const [activity, setActivity] = useState(null);
  const [audit, setAudit] = useState([]);
  const [versions, setVersions] = useState([]);
  const [options, setOptions] = useState({ categories: [], academic_years: [], semesters: [] });
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [proofError, setProofError] = useState('');
  const [loading, setLoading] = useState(true);
  const [openingProof, setOpeningProof] = useState(false);

  // Student Resubmission Form State
  const [resubmitOpen, setResubmitOpen] = useState(false);
  const [resubmitForm, setResubmitForm] = useState({
    title: '',
    category: '',
    description: '',
    activity_date: '',
    academic_session: '',
    semester: '',
    remarks: '',
  });
  const [resubmitFile, setResubmitFile] = useState(null);
  const [resubmitting, setResubmitting] = useState(false);

  // Faculty Review Action State
  const [actionModal, setActionModal] = useState(null); // 'approve' | 'reject' | 'correction'
  const [actionRemarks, setActionRemarks] = useState('');
  const [processingAction, setProcessingAction] = useState(false);

  useEffect(() => {
    if (!router.isReady) return;
    const token = getToken();
    const u = getUser();
    if (!token || !u) {
      router.replace('/login');
      return;
    }
    setCurrentUser(u);
    loadData();
  }, [router.isReady, id]);

  const loadData = () => {
    setLoading(true);
    Promise.all([apiFetch(`/activities/${id}`), apiFetch(`/activities/${id}/audit`), getActivityVersions(id), getActivityOptions().catch(() => null)])
      .then(([a, h, v, o]) => {
        setActivity(a);
        setAudit(h);
        setVersions(v.versions || []);
        if (o) setOptions(o);
        setResubmitForm({
          title: a.title || '',
          category: a.category || '',
          description: a.description || '',
          activity_date: a.activity_date || '',
          academic_session: a.academic_session || '',
          semester: a.semester ? String(a.semester) : '',
          remarks: '',
        });
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const handleOpenProof = async (version) => {
    if (!activity) return;
    setOpeningProof(true);
    setProofError('');
    try {
      await viewProofDocument(activity.id, version);
    } catch (err) {
      setProofError(err.message);
    } finally {
      setOpeningProof(false);
    }
  };

  const handleStudentSubmitDraft = async () => {
    try {
      await submitDraft(activity.id);
      setSuccessMsg('Draft submitted successfully for faculty verification!');
      loadData();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleStudentResubmit = async (e) => {
    e.preventDefault();
    setResubmitting(true);
    setError('');
    try {
      const body = new FormData();
      body.append('title', resubmitForm.title.trim());
      body.append('category', resubmitForm.category);
      body.append('description', resubmitForm.description.trim());
      body.append('activity_date', resubmitForm.activity_date);
      body.append('academic_session', resubmitForm.academic_session);
      body.append('semester', resubmitForm.semester);
      body.append('remarks', resubmitForm.remarks.trim());
      if (resubmitFile) body.append('proof', resubmitFile);

      await resubmitActivity(activity.id, body);
      setSuccessMsg('Activity resubmitted. It is now version ' + (activity.version + 1) + ' and has returned to the faculty review queue; your earlier version stays on record.');
      setResubmitOpen(false);
      setResubmitFile(null);
      loadData();
    } catch (err) {
      setError(err.message);
    } finally {
      setResubmitting(false);
    }
  };

  const handleFacultyAction = async () => {
    setProcessingAction(true);
    setError('');
    try {
      if (actionModal === 'approve') {
        await approveActivity(activity.id, actionRemarks, activity.version);
        setSuccessMsg('Activity approved and added to student verified portfolio.');
      } else if (actionModal === 'reject') {
        if (!actionRemarks.trim()) throw new Error('A rejection remark is required.');
        await rejectActivity(activity.id, actionRemarks, activity.version);
        setSuccessMsg('Activity rejected with faculty feedback.');
      } else if (actionModal === 'correction') {
        if (!actionRemarks.trim()) throw new Error('Correction notes/instructions are required.');
        await requestCorrection(activity.id, actionRemarks, activity.version);
        setSuccessMsg('Correction requested. Student notified with instructions.');
      }
      setActionModal(null);
      setActionRemarks('');
      loadData();
    } catch (err) {
      setError(err.message);
      if (err.status === 409) { setActionModal(null); loadData(); } // someone else decided, or the student resubmitted: show the latest state
    } finally {
      setProcessingAction(false);
    }
  };

  const backHref = currentUser?.role === 'student' ? '/dashboard' : '/faculty';

  if (loading) {
    return (
      <div className="app-shell">
        <main className="page-wrap">
          <div className="card p-14 text-center text-xs font-semibold text-ink-secondary">
            <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-navy border-t-transparent"></div>
            <p className="mt-2">Loading activity record details…</p>
          </div>
        </main>
      </div>
    );
  }

  if (error && !activity) {
    return (
      <div className="app-shell">
        <main className="page-wrap">
          <Link href={backHref} className="btn-secondary text-xs font-bold">
            ← Back
          </Link>
          <div className="mt-4 rounded-xl border border-rose-200 bg-danger-soft p-6 text-xs font-semibold text-danger-text">
            {error || 'Activity record not found'}
          </div>
        </main>
      </div>
    );
  }

  const isOwner = currentUser?.id === activity.student_id;
  const isFacultyOrAdmin = currentUser?.role === 'faculty' || currentUser?.role === 'admin';
  const catClass = categoryColors[activity.category] || 'bg-slate-100 text-slate-700 border-slate-200';

  return (
    <div className="app-shell">
      <main className="page-wrap">
        {/* Navigation & Header */}
        <div className="flex items-center justify-between">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-brand-text hover:text-ink-strong transition"
          >
            ← Back to {currentUser?.role === 'student' ? 'My Dashboard' : 'Verification Center'}
          </Link>
          <span className="rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-bold text-brand-text">
            Record ID: #{activity.id}
          </span>
        </div>

        {successMsg && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-success-soft p-4 text-xs font-semibold text-emerald-800">
            ✓ {successMsg}
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-danger-soft p-4 text-xs font-semibold text-danger-text">
            ✕ {error}
          </div>
        )}

        <div className="mt-4 rounded-2xl border border-brand-line bg-gradient-to-r from-brand-soft via-surface to-accent-soft p-6 shadow-sm sm:p-7">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${catClass}`}>
                  {activity.category}
                </span>
                <StatusBadge status={activity.status} />
                {activity.is_duplicate && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-warn-soft px-2 py-0.5 text-[10px] font-bold text-warn-text">
                    ⚠ Duplicate proof flag
                  </span>
                )}
                {isFacultyOrAdmin && activity.duplicate_of && (
                  <span className="text-[11px] font-semibold text-warn-text">
                    Same file as earlier submission{' '}
                    <Link href={`/activity/${activity.duplicate_of}`} className="underline">#{activity.duplicate_of}</Link> (for manual inspection)
                  </span>
                )}
              </div>
              <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink-strong sm:text-3xl">
                {activity.title}
              </h1>
              <p className="mt-1 text-xs text-ink-secondary">
                Submitted by <strong className="text-ink-strong">{activity.student_name}</strong> on {new Date(activity.created_at).toLocaleString()}
              </p>
            </div>

            {/* Quick action buttons depending on role & status */}
            <div className="flex flex-wrap items-center gap-2">
              {isOwner && activity.status === 'draft' && (
                <>
                  <Link href={`/dashboard?edit=${activity.id}`} className="btn-secondary py-2 px-4 text-xs font-bold" data-testid="edit-draft-link">
                    Edit draft
                  </Link>
                  <button
                    onClick={handleStudentSubmitDraft}
                    disabled={!activity.has_proof}
                    className="btn-primary py-2 px-4 text-xs font-bold"
                    title={!activity.has_proof ? 'Attach proof before submitting' : 'Submit draft for review'}
                  >
                    Submit Draft for Review
                  </button>
                </>
              )}

              {isOwner && activity.status === 'correction_requested' && (
                <button
                  onClick={() => setResubmitOpen(!resubmitOpen)}
                  className="btn-primary py-2 px-4 text-xs font-bold bg-solid-flame hover:bg-solid-flame-hover"
                >
                  {resubmitOpen ? 'Close Correction Form' : 'Resubmit with Corrections'}
                </button>
              )}

              {isFacultyOrAdmin && (activity.status === 'pending' || activity.status === 'resubmitted') && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setActionModal('approve');
                      setActionRemarks('');
                    }}
                    className="btn-primary py-2 px-3.5 text-xs font-bold bg-solid-success hover:bg-solid-success-hover"
                  >
                    ✓ Approve
                  </button>
                  <button
                    onClick={() => {
                      setActionModal('correction');
                      setActionRemarks('');
                    }}
                    className="btn-secondary py-2 px-3.5 text-xs font-bold text-flame-text border-orange-300 hover:bg-orange-50"
                  >
                    ✎ Request Correction
                  </button>
                  <button
                    onClick={() => {
                      setActionModal('reject');
                      setActionRemarks('');
                    }}
                    className="btn-secondary py-2 px-3.5 text-xs font-bold text-danger-text border-rose-300 hover:bg-rose-50"
                  >
                    ✕ Reject
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Correction Feedback Attention Banner */}
        {activity.status === 'correction_requested' && (
          <div className="mt-5 rounded-2xl border border-orange-300 bg-flame-soft p-5 shadow-xs">
            <div className="flex items-start gap-3">
              <span className="text-xl">⚠️</span>
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-orange-950">Faculty Correction Instructions</h3>
                <p className="text-xs leading-relaxed text-orange-900 bg-surface p-3 rounded-xl border border-orange-200">
                  {activity.correction_notes || 'Please review and resubmit with updated details or clearer evidence.'}
                </p>
                {activity.reviewer_name && (
                  <p className="text-[11px] font-semibold text-orange-800 pt-1">
                    Requested by: {activity.reviewer_name}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Resubmit Form Modal / Accordion */}
        {resubmitOpen && isOwner && (
          <div className="mt-5 rounded-2xl border border-brand bg-surface p-6 shadow-md animate-fade-in">
            <div className="border-b border-line-soft pb-3 mb-4">
              <h2 className="text-base font-bold text-ink-strong">Resubmit Activity with Corrections</h2>
              <p className="text-xs text-ink-secondary">
                Make any necessary adjustments to title, description, or attach an updated proof document.
              </p>
            </div>

            <form onSubmit={handleStudentResubmit} className="space-y-4" data-testid="resubmit-form">
              <div>
                <label className="field-label" htmlFor="rs-title">Title</label>
                <input id="rs-title" className="field" value={resubmitForm.title} onChange={(e) => setResubmitForm({ ...resubmitForm, title: e.target.value })} />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="rs-cat">Category</label>
                  <select id="rs-cat" className="field" value={resubmitForm.category} onChange={(e) => setResubmitForm({ ...resubmitForm, category: e.target.value })}>
                    <option value="">Select a category</option>
                    {options.categories.map((c) => <option key={c.name} value={c.name}>{c.display_name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="rs-date">Activity Date</label>
                  <input id="rs-date" type="date" className="field" value={resubmitForm.activity_date} onChange={(e) => setResubmitForm({ ...resubmitForm, activity_date: e.target.value })} />
                </div>
                <div>
                  <label className="field-label" htmlFor="rs-year">Academic Year</label>
                  <select id="rs-year" className="field" value={resubmitForm.academic_session} onChange={(e) => setResubmitForm({ ...resubmitForm, academic_session: e.target.value })}>
                    <option value="">Select year</option>
                    {[...new Set([...(resubmitForm.academic_session ? [resubmitForm.academic_session] : []), ...(options.open_academic_years || options.academic_years)])].map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="rs-sem">Semester</label>
                  <select id="rs-sem" className="field" value={resubmitForm.semester} onChange={(e) => setResubmitForm({ ...resubmitForm, semester: e.target.value })}>
                    <option value="">Select semester</option>
                    {options.semesters.map((n) => <option key={n} value={String(n)}>Semester {n}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="field-label" htmlFor="rs-desc">Description / Corrected Details</label>
                <textarea id="rs-desc" className="field resize-none" rows={3} value={resubmitForm.description} onChange={(e) => setResubmitForm({ ...resubmitForm, description: e.target.value })} />
              </div>

              <div>
                <label className="field-label" htmlFor="rs-note">Note for Reviewer (what did you correct?)</label>
                <textarea id="rs-note" className="field resize-none" rows={2} maxLength={1000}
                  placeholder="e.g. Attached the official high-resolution certificate with the verifiable QR code."
                  value={resubmitForm.remarks} onChange={(e) => setResubmitForm({ ...resubmitForm, remarks: e.target.value })} />
                <span className="mt-1 block text-[11px] text-ink-muted">Required if you change nothing else.</span>
              </div>

              <div>
                <label className="field-label">Replace Proof Document (Optional)</label>
                <input
                  ref={fileInputRef}
                  data-testid="resubmit-proof"
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp"
                  onChange={(e) => setResubmitFile(e.target.files?.[0] || null)}
                  className="text-xs text-ink-secondary"
                />
                <span className="block mt-1 text-[11px] text-ink-muted">
                  Leave empty to keep your current proof ({activity.proof_original_name}). The earlier file is always kept on record.
                </span>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
                <button
                  type="button"
                  onClick={() => setResubmitOpen(false)}
                  className="btn-secondary py-2 px-4 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resubmitting}
                  className="btn-primary py-2 px-5 text-xs font-bold"
                >
                  {resubmitting ? 'Resubmitting…' : 'Submit Corrections'}
                </button>
              </div>
            </form>
          </div>
        )}

        {proofError && (
          <div className="mt-5 rounded-xl border border-rose-200 bg-danger-soft p-4 text-xs font-semibold text-danger-text">
            {proofError}
          </div>
        )}

        {/* 2-Column Details Layout */}
        <div className="mt-7 grid grid-cols-1 gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          {/* Left Column: Details & Evidence */}
          <div className="min-w-0 space-y-6">
            {/* Record Information */}
            <section className="card card-pad">
              <h2 className="section-title text-sm">Submission Details</h2>
              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Detail label="Student Name" value={activity.student_name} />
                <Detail label="Student Email" value={activity.student_email} />
                <Detail label="Academic Department" value={activity.department || 'Not specified'} />
                <Detail label="Activity Category" value={activity.category} />
                <Detail label="Activity Date" value={activity.activity_date ? new Date(`${activity.activity_date}T00:00:00`).toLocaleDateString() : '—'} />
                <Detail label="Academic Year" value={activity.academic_session || '—'} />
                <Detail label="Semester" value={activity.semester ? `Semester ${activity.semester}` : '—'} />
                {activity.status !== 'draft' && <Detail label="Current Submission" value={`Version ${activity.version}`} />}
                <Detail label="Submission Date" value={new Date(activity.created_at).toLocaleString()} />
                <Detail
                  label="Verification Status"
                  value={
                    activity.reviewed_at
                      ? `Reviewed on ${new Date(activity.reviewed_at).toLocaleDateString()}`
                      : 'Pending review'
                  }
                />
              </div>

              {activity.description && (
                <div className="mt-6 border-t border-line-soft pt-4">
                  <p className="field-label">Activity Description</p>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-secondary bg-surface-alt p-3 rounded-xl border border-line">
                    {activity.description}
                  </p>
                </div>
              )}

              {/* Status Decision Remarks */}
              {activity.status === 'rejected' && (
                <div className="mt-6 rounded-xl border border-rose-200 bg-danger-soft p-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-danger-text">
                    Faculty Rejection Remarks
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-danger-text">
                    {activity.review_remarks || 'No detailed remarks provided.'}
                  </p>
                  {activity.reviewer_name && (
                    <p className="mt-2 text-[11px] font-semibold text-danger-text">
                      Reviewed by: {activity.reviewer_name}
                    </p>
                  )}
                </div>
              )}

              {activity.status === 'approved' && (
                <div className="mt-6 rounded-xl border border-emerald-200 bg-success-soft p-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-success-text">
                    Faculty Verification Confirmation
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-success-text">
                    {activity.review_remarks || 'Evidence verified against official academic guidelines.'}
                  </p>
                  {activity.reviewer_name && (
                    <p className="mt-2 text-[11px] font-semibold text-success-text">
                      Approved by: {activity.reviewer_name}
                    </p>
                  )}
                </div>
              )}
            </section>

            {/* Evidence Document Inspection */}
            <section className="card card-pad">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <div>
                  <h2 className="section-title text-sm">Supporting Evidence Document</h2>
                  <p className="mt-1 text-xs font-bold text-ink-strong">
                    {activity.proof_original_name || 'No proof document attached yet'}
                  </p>
                  {activity.proof_size && (
                    <p className="text-[11px] text-ink-secondary">
                      MIME: {activity.proof_mime_type} · {(activity.proof_size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  )}
                </div>

                {activity.has_proof && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={openingProof}
                    onClick={() => handleOpenProof()}
                  >
                    <svg className="h-3.5 w-3.5 text-brand-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    {openingProof ? 'Opening Document…' : 'Inspect Proof Document ↗'}
                  </button>
                )}
              </div>

              <div className="mt-4 rounded-xl border border-brand-line bg-brand-soft/60 p-3.5 text-xs leading-5 text-ink">
                <p>
                  <strong>Secure File Architecture:</strong> Original proof documents are stored in the server
                  file repository outside of public web roots. Documents are served exclusively through JWT-authorized
                  endpoints to protect student privacy and prevent unauthorized downloads.
                </p>
              </div>
            </section>

            {/* Submission history: every version, with its own proof */}
            {versions.length > 0 && (
              <section className="card card-pad" data-testid="version-history">
                <h2 className="section-title text-sm">Submission History</h2>
                <p className="mt-0.5 text-xs text-ink-secondary">Each submission is kept exactly as it was sent. Resubmitting adds a new version and never replaces the old one.</p>
                <ol className="mt-4 space-y-3">
                  {[...versions].reverse().map((v) => (
                    <li key={v.version} className="rounded-xl border border-line p-3.5 text-xs" data-testid={`version-${v.version}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-bold text-ink-strong">
                          Version {v.version}
                          {v.version === activity.version && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent-text">Current</span>}
                        </span>
                        <span className="text-[10px] text-ink-muted">{new Date(v.created_at).toLocaleString()}</span>
                      </div>
                      <p className="mt-1 font-semibold text-ink">{v.title}</p>
                      {v.note && <p className="mt-1 rounded-lg bg-surface-alt p-2 text-ink-secondary"><strong>Student&apos;s note:</strong> {v.note}</p>}
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-secondary">
                        <span className="truncate">📎 {v.proof_original_name || 'No file'}{v.proof_size ? ` · ${(v.proof_size / 1024 / 1024).toFixed(2)} MB` : ''}{v.file_hash ? ` · SHA-256 ${v.file_hash.slice(0, 12)}…` : ''}</span>
                        {v.has_proof && (
                          <button type="button" className="font-bold text-brand-text hover:underline" disabled={openingProof} onClick={() => handleOpenProof(v.version)}>
                            Open this version&apos;s proof ↗
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>

          {/* Right Column: Cryptographic Engine & Audit Timeline */}
          <div className="min-w-0 space-y-6">
            {/* Cryptographic Engine Signals */}
            <section className="card card-pad">
              <h2 className="section-title text-sm">Verification Engine Signals</h2>
              <div className="mt-4 space-y-2.5">
                <CheckSignal ok={!!activity.has_proof} text="Proof document uploaded and accessible" />
                <CheckSignal ok={!!activity.file_hash} text="Cryptographic SHA-256 hash computed" />
                <CheckSignal
                  ok={!activity.is_duplicate}
                  warning={activity.is_duplicate}
                  text={
                    activity.is_duplicate
                      ? 'Duplicate hash flag: identical file already exists on record'
                      : 'Unique evidence digest: no collisions detected'
                  }
                />
                <CheckSignal
                  ok={activity.status === 'approved'}
                  pending={activity.status === 'pending' || activity.status === 'resubmitted'}
                  warning={activity.status === 'rejected' || activity.status === 'correction_requested'}
                  text={
                    activity.status === 'approved'
                      ? 'Faculty verification completed and approved'
                      : activity.status === 'correction_requested'
                      ? 'Faculty requested corrections'
                      : activity.status === 'rejected'
                      ? 'Faculty verification completed: rejected with feedback'
                      : activity.status === 'resubmitted'
                      ? 'Corrections resubmitted: in verification queue'
                      : activity.status === 'draft'
                      ? 'Saved as draft (not yet submitted)'
                      : 'Faculty verification pending review'
                  }
                />
              </div>

              {activity.file_hash && (
                <div className="mt-5 rounded-xl border border-brand-line bg-brand-soft/50 p-3.5">
                  <p className="field-label">SHA-256 Digest</p>
                  <p className="break-all font-mono text-[10px] leading-relaxed text-ink-strong bg-surface p-2.5 rounded-lg border border-brand-line">
                    {activity.file_hash}
                  </p>
                  <p className="mt-1.5 text-[11px] text-ink-secondary">
                    Used for evidence collision screening across institutional records.
                  </p>
                </div>
              )}
            </section>

            {/* Audit Log Timeline */}
            <section className="card card-pad">
              <h2 className="section-title text-sm">Verification Timeline & Audit Trail</h2>
              <p className="mt-0.5 text-xs text-ink-secondary">Traceable record of all state transitions</p>

              <div className="mt-5 space-y-4">
                {audit.length === 0 ? (
                  <p className="text-xs text-ink-secondary">No state transitions recorded yet.</p>
                ) : (
                  audit.map((entry, idx) => (
                    <div key={entry.id || idx} className="relative flex gap-3 pb-4 last:pb-0">
                      {idx !== audit.length - 1 && (
                        <div className="absolute left-2.5 top-5 -bottom-1 w-0.5 bg-line" />
                      )}
                      <div className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full bg-navy text-[10px] text-white">
                        •
                      </div>
                      <div className="flex-1 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-ink-strong capitalize">
                            {entry.new_status ? entry.new_status.replace(/_/g, ' ') : 'Updated'}
                            {entry.version ? <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-bold normal-case text-brand-text">v{entry.version}</span> : null}
                          </span>
                          <span className="text-[10px] text-ink-muted">
                            {new Date(entry.created_at).toLocaleDateString()} {new Date(entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        {entry.remarks && (
                          <p className="mt-1 text-ink-secondary bg-surface-alt p-2 rounded-lg border border-line-soft">
                            {entry.remarks}
                          </p>
                        )}
                        {entry.reviewer_name && (
                          <p className="mt-0.5 text-[10px] text-brand-text">By {entry.reviewer_name}</p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>

        {/* Action Modal for Faculty / Admin */}
        {actionModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 animate-fade-in">
            <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl">
              <h3 className="text-base font-bold text-ink-strong">
                {actionModal === 'approve' && 'Approve Activity'}
                {actionModal === 'reject' && 'Reject Activity'}
                {actionModal === 'correction' && 'Request Corrections'}
              </h3>
              <p className="mt-1 text-xs text-ink-secondary">
                {actionModal === 'approve' && 'Confirm approval for official inclusion in portfolio.'}
                {actionModal === 'reject' && 'Provide constructive rejection remarks explaining why.'}
                {actionModal === 'correction' && 'Specify required changes or clearer evidence needed from the student.'}
              </p>

              <div className="mt-4">
                <label className="field-label">
                  {actionModal === 'approve' ? 'Remarks (Optional)' : 'Remarks / Instructions *'}
                </label>
                <textarea
                  className="field resize-none text-xs"
                  rows={3}
                  placeholder={
                    actionModal === 'approve'
                      ? 'Verified against competition criteria.'
                      : actionModal === 'correction'
                      ? 'Please upload certificate with legible seal and date.'
                      : 'Missing institutional verification signatures.'
                  }
                  value={actionRemarks}
                  onChange={(e) => setActionRemarks(e.target.value)}
                  required={actionModal !== 'approve'}
                />
              </div>

              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setActionModal(null)}
                  className="btn-secondary py-2 px-4 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={processingAction}
                  onClick={handleFacultyAction}
                  className={`btn-primary py-2 px-4 text-xs font-bold ${
                    actionModal === 'approve'
                      ? 'bg-solid-success hover:bg-solid-success-hover'
                      : actionModal === 'reject'
                      ? 'bg-solid-danger hover:bg-solid-danger-hover'
                      : 'bg-solid-flame hover:bg-solid-flame-hover'
                  }`}
                >
                  {processingAction ? 'Processing…' : 'Confirm Decision'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-ink-secondary">{label}</p>
      <p className="mt-0.5 break-words [overflow-wrap:anywhere] text-xs font-bold text-ink-strong">{value || '—'}</p>
    </div>
  );
}

function CheckSignal({ ok, warning, pending, text }) {
  let badge = (
    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-success-text">
      ✓
    </span>
  );
  if (warning) {
    badge = (
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-[10px] font-bold text-warn-text">
        ⚠
      </span>
    );
  } else if (pending) {
    badge = (
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[10px] font-bold text-blue-700">
        ⏳
      </span>
    );
  } else if (!ok) {
    badge = (
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-ink-body">
        ○
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-ink">
      {badge}
      <span className={warning ? 'font-semibold text-amber-800' : ''}>{text}</span>
    </div>
  );
}
