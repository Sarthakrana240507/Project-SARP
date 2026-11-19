import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  previewImport, confirmImport, cancelImport,
  getImportHistory, getImportDetail, downloadActivationLinks,
} from '@/lib/api';

// Everything that differs between the two imports lives here.
const KINDS = {
  students: {
    kind: 'STUDENT', path: 'students', idField: 'student_id', idLabel: 'Student ID', people: 'students', person: 'student',
    title: 'Import students from CSV',
    columns: 'student_id, name, email, department, programme, academic_year, semester',
    template: 'student_id,name,email,department,programme,academic_year,semester\n',
    file: 'sarp-student-import-template.csv',
    extra: [['department', 'Department'], ['academic_year', 'Year'], ['semester', 'Sem']],
  },
  faculty: {
    kind: 'FACULTY', path: 'faculty', idField: 'faculty_id', idLabel: 'Faculty ID', people: 'faculty members', person: 'faculty member',
    title: 'Import faculty from CSV',
    columns: 'faculty_id, name, email, department (optional: designation)',
    template: 'faculty_id,name,email,department,designation\n',
    file: 'sarp-faculty-import-template.csv',
    extra: [['department', 'Department'], ['designation', 'Designation']],
  },
};

function downloadTemplate(cfg) {
  const url = URL.createObjectURL(new Blob([cfg.template], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = cfg.file;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

const Stat = ({ label, value, tone }) => (
  <div className="rounded-xl border border-line bg-surface px-4 py-3">
    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{label}</p>
    <p className={`text-xl font-bold ${tone || 'text-ink-strong'}`}>{value}</p>
  </div>
);

export default function RosterImport({ kind = 'students' }) {
  const cfg = KINDS[kind];
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [openErrors, setOpenErrors] = useState(null); // { id, errors }
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const loadHistory = useCallback(async () => {
    try { setHistory((await getImportHistory(cfg.kind)).imports); } catch (e) { setError(e.message); }
  }, [cfg.kind]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const run = async (label, fn) => {
    setError(''); setBusy(label);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const doPreview = (e) => {
    e.preventDefault();
    if (!file) return setError('Choose a CSV file first');
    run('preview', async () => {
      setResult(null);
      setPreview(await previewImport(cfg.path, file));
      loadHistory();
    });
  };
  const doConfirm = () => run('confirm', async () => {
    const r = await confirmImport(cfg.path, preview.batch_id);
    setResult(r); setPreview(null); setFile(null);
    if (fileRef.current) fileRef.current.value = '';
    loadHistory();
  });
  const doCancel = () => run('cancel', async () => {
    await cancelImport(cfg.path, preview.batch_id);
    setPreview(null); setFile(null);
    if (fileRef.current) fileRef.current.value = '';
    loadHistory();
  });
  const showErrors = (id) => run('errors', async () => {
    if (openErrors?.id === id) return setOpenErrors(null);
    setOpenErrors({ id, errors: (await getImportDetail(id)).import.errors || [] });
  });

  return (
    <div className="space-y-6">
      <div className="card card-pad shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Bulk import</p>
            <h2 className="section-title mt-1">{cfg.title}</h2>
            <p className="mt-1 text-xs text-ink-secondary">
              Columns: {cfg.columns}. Accounts are created as Invited with no password; {cfg.people} activate them themselves.
            </p>
          </div>
          <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => downloadTemplate(cfg)}>Download template</button>
        </div>

        <form onSubmit={doPreview} className="mt-5 flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" accept=".csv,text/csv" data-testid="csv-input"
            onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setResult(null); }}
            className="block max-w-full text-xs text-ink-body file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-3 file:py-2 file:text-xs file:font-bold file:text-brand-text" />
          <button type="submit" className="btn-primary px-4 py-2 text-xs" disabled={!file || busy === 'preview'}>
            {busy === 'preview' ? 'Checking…' : 'Preview import'}
          </button>
        </form>

        {error && <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-danger-soft p-3 text-xs font-semibold text-danger-text">{error}</div>}

        {preview && (
          <div className="mt-6" data-testid="import-preview">
            <div className="grid grid-cols-3 gap-3 sm:max-w-md">
              <Stat label="Rows" value={preview.total_rows} />
              <Stat label="Valid" value={preview.valid_rows} tone="text-success-text" />
              <Stat label="Errors" value={preview.error_rows} tone={preview.error_rows ? 'text-danger-text' : undefined} />
            </div>

            {preview.errors.length > 0 && (
              <div className="mt-5">
                <h3 className="text-xs font-bold text-ink-strong">Rows that will be skipped</h3>
                <div className="mt-2 max-h-64 overflow-auto rounded-xl border border-line">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-surface-alt text-[11px] uppercase text-ink-secondary">
                      <tr><th className="px-3 py-2">Line</th><th className="px-3 py-2">{cfg.idLabel}</th><th className="px-3 py-2">Problem</th></tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      {preview.errors.map((er) => (
                        <tr key={er.line}>
                          <td className="px-3 py-2 font-semibold">{er.line}</td>
                          <td className="px-3 py-2">{er[cfg.idField] || '—'}</td>
                          <td className="px-3 py-2 text-danger-text">{er.messages.join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.errors_truncated && <p className="mt-1 text-[11px] text-ink-secondary">Only the first {preview.errors.length} errors are shown.</p>}
              </div>
            )}

            {preview.sample.length > 0 && (
              <div className="mt-5">
                <h3 className="text-xs font-bold text-ink-strong">Valid rows (first {preview.sample.length})</h3>
                <div className="mt-2 overflow-x-auto rounded-xl border border-line">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-surface-alt text-[11px] uppercase text-ink-secondary">
                      <tr><th className="px-3 py-2">{cfg.idLabel}</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Email</th>{cfg.extra.map(([, l]) => <th key={l} className="px-3 py-2">{l}</th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      {preview.sample.map((r) => (
                        <tr key={r[cfg.idField]}><td className="px-3 py-2">{r[cfg.idField]}</td><td className="px-3 py-2">{r.name}</td><td className="px-3 py-2">{r.email}</td>{cfg.extra.map(([k]) => <td key={k} className="px-3 py-2">{r[k] || '—'}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button className="btn-primary px-4 py-2 text-xs" onClick={doConfirm} disabled={preview.valid_rows === 0 || busy === 'confirm'}>
                {busy === 'confirm' ? 'Importing…' : `Import ${preview.valid_rows} valid ${preview.valid_rows === 1 ? 'row' : 'rows'}`}
              </button>
              <button className="btn-secondary px-4 py-2 text-xs" onClick={doCancel} disabled={busy === 'cancel'}>Cancel</button>
              {preview.error_rows > 0 && <span className="text-[11px] text-ink-secondary">Skipped rows are not imported. Fix them and upload again.</span>}
            </div>
          </div>
        )}

        {result && (
          <div className="mt-6 rounded-xl border border-emerald-200 bg-success-soft p-4 text-xs text-emerald-900" data-testid="import-result" role="status">
            <p className="text-sm font-bold">Import complete</p>
            <p className="mt-1">{result.imported} accounts created, {result.failed} rows not imported.</p>
            <p className="mt-1">{result.invitations.note}</p>
            {result.invitations.mode === 'NONE' && result.imported > 0 && (
              <button className="btn-primary mt-3 px-4 py-2 text-xs" onClick={() => run('links', () => downloadActivationLinks(result.batch_id).then(loadHistory))}>
                Download activation links (CSV)
              </button>
            )}
          </div>
        )}
      </div>

      <div className="card shadow-card">
        <div className="px-5 pt-5">
          <h2 className="section-title">Import history</h2>
        </div>
        {history.length === 0 ? (
          <p className="px-5 py-8 text-center text-xs text-ink-secondary">No imports yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="import-history">
              <thead className="bg-surface-alt text-[11px] uppercase text-ink-secondary">
                <tr><th className="px-5 py-2">File</th><th className="px-3 py-2">When</th><th className="px-3 py-2">By</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Imported</th><th className="px-3 py-2">Failed</th><th className="px-3 py-2">Not yet activated</th><th className="px-3 py-2 text-right">Actions</th></tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {history.map((h) => (
                  <Fragment key={h.id}>
                    <tr>
                      <td className="px-5 py-2.5 font-semibold text-ink-strong">{h.filename}</td>
                      <td className="px-3 py-2.5">{new Date(h.created_at).toLocaleString()}</td>
                      <td className="px-3 py-2.5">{h.uploaded_by_name || '—'}</td>
                      <td className="px-3 py-2.5">{h.status.charAt(0) + h.status.slice(1).toLowerCase()}</td>
                      <td className="px-3 py-2.5">{h.imported_count ?? '—'}</td>
                      <td className="px-3 py-2.5">{h.failed_count ?? '—'}</td>
                      <td className="px-3 py-2.5">{h.status === 'COMMITTED' ? h.still_invited : '—'}</td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {h.status === 'COMMITTED' && (
                          <button className="px-2 py-1 font-bold text-brand-text hover:underline" onClick={() => showErrors(h.id)}>
                            {openErrors?.id === h.id ? 'Hide errors' : 'Errors'}
                          </button>
                        )}
                        {h.status === 'COMMITTED' && h.still_invited > 0 && (
                          <button className="px-2 py-1 font-bold text-brand-text hover:underline" onClick={() => run('links', () => downloadActivationLinks(h.id).then(loadHistory))}>
                            Activation links
                          </button>
                        )}
                      </td>
                    </tr>
                    {openErrors?.id === h.id && (
                      <tr>
                        <td colSpan={8} className="bg-surface-alt px-5 py-3">
                          {openErrors.errors.length === 0 ? <p className="text-[11px] text-ink-secondary">No row errors.</p> : (
                            <ul className="space-y-1 text-[11px] text-danger-text">
                              {openErrors.errors.map((er) => <li key={er.line}>Line {er.line} ({er[cfg.idField] || '—'}): {er.messages.join('; ')}</li>)}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
