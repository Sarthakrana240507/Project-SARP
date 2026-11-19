import { useEffect, useRef, useState } from 'react';
import { createActivity, saveDraft, updateDraft, submitDraft, deleteDraft, getActivityOptions } from '@/lib/api';

const FALLBACK = {
  categories: [], academic_years: [], open_academic_years: [], current_academic_year: '', current_semester: null,
  semesters: [1, 2, 3, 4, 5, 6, 7, 8], limits: { max_proof_mb: 10, title_min: 3, title_max: 150, description_max: 2000 },
};
const ALLOWED_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const emptyForm = (o) => ({
  title: '', category: '', description: '', activity_date: '',
  academic_session: o.current_academic_year || '', semester: o.current_semester ? String(o.current_semester) : '',
});
const fromDraft = (d) => ({
  title: d.title === 'Untitled draft' ? '' : d.title || '', category: d.category || '', description: d.description || '',
  activity_date: d.activity_date || '', academic_session: d.academic_session || '', semester: d.semester ? String(d.semester) : '',
});

// Same rules as the server (which is the one that actually enforces them); this just saves a round trip.
function check(form, file, o, { strict }) {
  const e = {};
  const L = o.limits;
  const title = form.title.trim();
  if (!title) { if (strict) e.title = 'Title is required.'; }
  else if (title.length < L.title_min || title.length > L.title_max) e.title = `Title must be ${L.title_min}-${L.title_max} characters.`;
  if (strict && !form.category) e.category = 'Choose a category.';
  if (form.description.length > L.description_max) e.description = `Description must be at most ${L.description_max} characters.`;
  if (!form.activity_date) { if (strict) e.activity_date = 'Activity date is required.'; }
  else if (form.activity_date > todayLocal()) e.activity_date = 'Activity date cannot be in the future.';
  if (strict && !form.academic_session) e.academic_session = 'Choose the academic year.';
  if (strict && !form.semester) e.semester = 'Choose the semester.';
  if (file) {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) e.proof = 'Proof must be a PDF, PNG, JPG, JPEG or WEBP file.';
    else if (file.size > L.max_proof_mb * 1024 * 1024) e.proof = `Proof file is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is ${L.max_proof_mb} MB.`;
  }
  return e;
}

const Err = ({ id, text }) => (text ? <p id={id} role="alert" className="mt-1 text-[11px] font-semibold text-danger-text">{text}</p> : null);

/**
 * Create mode (no `draft`): "Save as Draft" or "Submit for Verification".
 * Edit mode (`draft` given): same form pre-filled; saves into that draft, submits it, or discards it.
 */
export default function ActivityForm({ draft = null, onSubmitted, onCancel }) {
  const fileInputRef = useRef(null);
  const [options, setOptions] = useState(FALLBACK);
  const [form, setForm] = useState(emptyForm(FALLBACK));
  const [file, setFile] = useState(null);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [busy, setBusy] = useState(''); // 'draft' | 'submit' | 'discard'
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const editing = Boolean(draft);

  useEffect(() => {
    getActivityOptions().then((o) => {
      setOptions(o);
      if (!draft) setForm((f) => ({ ...emptyForm(o), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching between "new" and "edit this draft" resets the form.
  useEffect(() => {
    setForm(draft ? fromDraft(draft) : emptyForm(options));
    setFile(null); setErrors({}); setError(''); setWarning(''); setConfirmDiscard(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id]);

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  const chooseFile = (e) => {
    const selected = e.target.files?.[0] || null;
    const problem = selected ? check(form, selected, options, { strict: false }).proof : null;
    if (problem) { setErrors((x) => ({ ...x, proof: problem })); setFile(null); e.target.value = ''; return; }
    setErrors((x) => ({ ...x, proof: undefined }));
    setFile(selected);
  };
  const removeFile = () => { setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; };

  const body = () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.append(k, typeof v === 'string' ? (k === 'description' ? v.trim() : v.trim()) : v);
    if (file) fd.append('proof', file);
    return fd;
  };

  const run = async (kind, strict, action) => {
    setError(''); setWarning('');
    const e = check(form, file, options, { strict });
    if (strict && !file && !(editing && draft.has_proof)) e.proof = 'Attach a supporting proof document. To save without it, use "Save as Draft".';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(kind);
    try {
      const result = await action();
      if (result?.warning) setWarning(result.warning);
      onSubmitted?.(result, kind);
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      setError(err.message);
    } finally { setBusy(''); }
  };

  const handleSaveDraft = () => run('draft', false, () => (editing ? updateDraft(draft.id, body()) : saveDraft(body())));
  const handleSubmit = (e) => { e.preventDefault(); return run('submit', true, () => (editing ? submitDraft(draft.id, body()) : createActivity(body()))); };
  const handleDiscard = async () => {
    setBusy('discard'); setError('');
    try { await deleteDraft(draft.id); onSubmitted?.({ ...draft, status: 'discarded' }, 'discard'); }
    catch (err) { setError(err.message); } finally { setBusy(''); setConfirmDiscard(false); }
  };

  const L = options.limits;
  const fieldClass = (k) => `field ${errors[k] ? 'border-rose-400 focus:border-rose-500' : ''}`;
  const aria = (k) => ({ 'aria-invalid': Boolean(errors[k]), 'aria-describedby': errors[k] ? `err-${k}` : undefined });

  return (
    <form onSubmit={handleSubmit} className="card card-pad space-y-4" noValidate data-testid="activity-form">
      <div className="border-b border-line-soft pb-3.5">
        <div className="flex items-center justify-between">
          <p className="eyebrow">{editing ? 'Editing draft' : 'Submission Portal'}</p>
          {editing && onCancel && (
            <button type="button" onClick={onCancel} className="text-[11px] font-bold text-brand-text hover:underline">Cancel editing</button>
          )}
        </div>
        <h2 className="section-title mt-1 text-lg">{editing ? 'Complete your draft' : 'Submit New Activity'}</h2>
        <p className="mt-1 text-xs text-ink-secondary">
          {editing
            ? 'Finish the details and submit it for verification, or keep it as a draft.'
            : 'Upload evidence for faculty review, or save it as a draft to finish later.'}
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-danger-soft p-3 text-xs text-danger-text"><span className="font-bold">✕ </span>{error}</div>
      )}
      {warning && (
        <div role="status" className="rounded-xl border border-amber-200 bg-warn-soft p-3 text-xs text-warn-text"><strong>Duplicate flag: </strong>{warning}</div>
      )}

      <div>
        <label className="field-label" htmlFor="af-title">Activity Title <span className="text-danger-text">*</span></label>
        <input id="af-title" className={fieldClass('title')} {...aria('title')} maxLength={L.title_max} placeholder="e.g. Smart India Hackathon 2026 Finals"
          value={form.title} onChange={(e) => set('title', e.target.value)} />
        <Err id="err-title" text={errors.title} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="af-category">Category <span className="text-danger-text">*</span></label>
          <select id="af-category" className={fieldClass('category')} {...aria('category')} value={form.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">Select a category</option>
            {options.categories.map((c) => <option key={c.name} value={c.name}>{c.display_name}</option>)}
          </select>
          <Err id="err-category" text={errors.category} />
        </div>
        <div>
          <label className="field-label" htmlFor="af-date">Activity Date <span className="text-danger-text">*</span></label>
          <input id="af-date" type="date" className={fieldClass('activity_date')} {...aria('activity_date')} max={todayLocal()}
            value={form.activity_date} onChange={(e) => set('activity_date', e.target.value)} />
          <Err id="err-activity_date" text={errors.activity_date} />
        </div>
        <div>
          <label className="field-label" htmlFor="af-year">Academic Year <span className="text-danger-text">*</span></label>
          <select id="af-year" className={fieldClass('academic_session')} {...aria('academic_session')} value={form.academic_session} onChange={(e) => set('academic_session', e.target.value)}>
            <option value="">Select year</option>
            {[...new Set([...(form.academic_session ? [form.academic_session] : []), ...(options.open_academic_years || options.academic_years)])].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <Err id="err-academic_session" text={errors.academic_session} />
        </div>
        <div>
          <label className="field-label" htmlFor="af-sem">Semester <span className="text-danger-text">*</span></label>
          <select id="af-sem" className={fieldClass('semester')} {...aria('semester')} value={form.semester} onChange={(e) => set('semester', e.target.value)}>
            <option value="">Select semester</option>
            {options.semesters.map((n) => <option key={n} value={String(n)}>Semester {n}</option>)}
          </select>
          <Err id="err-semester" text={errors.semester} />
        </div>
      </div>

      <div>
        <div className="flex items-end justify-between">
          <label className="field-label" htmlFor="af-desc">Description / Achievements</label>
          <span className={`mb-1.5 text-[10px] ${form.description.length > L.description_max ? 'font-bold text-danger-text' : 'text-ink-secondary'}`}>{form.description.length}/{L.description_max}</span>
        </div>
        <textarea id="af-desc" className={`${fieldClass('description')} resize-none text-xs leading-relaxed`} {...aria('description')} rows={3}
          placeholder="Describe your role, project highlights, ranking or outcome…" value={form.description} onChange={(e) => set('description', e.target.value)} />
        <Err id="err-description" text={errors.description} />
      </div>

      <div>
        <label className="field-label">Proof Evidence Document <span className="text-danger-text">*</span></label>
        {editing && draft.has_proof && !file && (
          <p className="mb-2 rounded-lg bg-brand-soft px-3 py-2 text-[11px] text-brand-strong">
            Current file: <strong>{draft.proof_original_name}</strong>. Choose a new file below only if you want to replace it.
          </p>
        )}
        {!file ? (
          <label className="group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-line-strong bg-surface-alt px-4 py-5 text-center transition hover:border-brand hover:bg-brand-soft/50">
            <span className="text-xs font-bold text-ink-strong">{editing && draft.has_proof ? 'Replace proof file' : 'Upload Certificate or Evidence'}</span>
            <span className="mt-0.5 text-[11px] text-ink-secondary">PDF, PNG, JPG, JPEG or WEBP · up to {L.max_proof_mb} MB</span>
            <input ref={fileInputRef} data-testid="proof-input" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={chooseFile} className="sr-only" />
          </label>
        ) : (
          <div className="flex items-center justify-between rounded-xl border border-brand-line bg-brand-soft p-3 text-xs">
            <div className="min-w-0">
              <p className="truncate font-bold text-ink-strong">📄 {file.name}</p>
              <p className="text-[11px] text-ink-secondary">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
            </div>
            <button type="button" onClick={removeFile} className="ml-2 rounded-lg px-2 py-1 text-xs font-semibold text-danger-text hover:bg-rose-50">Remove</button>
          </div>
        )}
        <Err id="err-proof" text={errors.proof} />
      </div>

      <div className="rounded-xl border border-brand-line bg-brand-soft/60 p-3 text-[11px] leading-5 text-ink-secondary">
        <strong className="text-ink-strong">Integrity check:</strong> the file&apos;s SHA-256 fingerprint is compared with earlier submissions. A match is only flagged for a faculty member to look at; it is not treated as fraud.
      </div>

      <div className="flex flex-col gap-2.5 pt-1 sm:flex-row">
        <button type="button" onClick={handleSaveDraft} className="btn-secondary flex-1 py-2.5 text-xs font-semibold" disabled={Boolean(busy)}>
          {busy === 'draft' ? 'Saving…' : editing ? 'Save Changes' : 'Save as Draft'}
        </button>
        <button type="submit" className="btn-primary flex-1 py-2.5 text-xs font-bold" disabled={Boolean(busy)}>
          {busy === 'submit' ? 'Submitting…' : 'Submit for Verification'}
        </button>
      </div>

      {editing && (
        <div className="border-t border-line-soft pt-3 text-xs">
          {!confirmDiscard ? (
            <button type="button" onClick={() => setConfirmDiscard(true)} className="font-semibold text-danger-text hover:underline">Discard this draft</button>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-rose-50 p-3 text-rose-800">
              <span className="font-semibold">Delete this draft and its file permanently?</span>
              <button type="button" onClick={handleDiscard} disabled={busy === 'discard'} className="btn-danger px-3 py-1.5 text-[11px]">{busy === 'discard' ? 'Deleting…' : 'Yes, delete'}</button>
              <button type="button" onClick={() => setConfirmDiscard(false)} className="font-semibold hover:underline">Keep it</button>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
