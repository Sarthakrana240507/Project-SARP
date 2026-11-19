import { useCallback, useEffect, useState } from 'react';
import {
  getFacultyList, createFaculty, updateFaculty, setFacultyScope,
  getAdminDepartments, createUserLink, setAdminUserStatus,
} from '@/lib/api';
import LinkModal from '@/components/admin/LinkModal';
import RosterImport from '@/components/admin/RosterImport';

const STATUS_STYLE = {
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  INVITED: 'bg-amber-100 text-amber-800',
  SUSPENDED: 'bg-rose-100 text-rose-800',
};
const emptyForm = { faculty_id: '', name: '', email: '', department: '', designation: '' };

function ScopeChips({ scope }) {
  if (!scope) return null;
  if (scope.all) return <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand-text">All departments</span>;
  if (scope.departments.length === 0) return <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-danger-text">No access</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {scope.departments.map((d) => <span key={d} className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand-text">{d}</span>)}
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="card card-pad max-h-[90vh] w-full max-w-lg overflow-y-auto shadow-card">
        <div className="flex items-start justify-between gap-3">
          <h3 className="section-title">{title}</h3>
          <button className="text-xs font-bold text-ink-secondary hover:text-ink-strong" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function FacultyManager({ onChanged }) {
  const [view, setView] = useState('list'); // 'list' | 'import'
  const [data, setData] = useState({ faculty: [], total: 0, page: 1, limit: 20 });
  const [departments, setDepartments] = useState([]);
  const [filters, setFilters] = useState({ search: '', department: '', account_status: '', page: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(null); // { mode: 'create' | 'edit', id?, values }
  const [formError, setFormError] = useState('');
  const [scopeEdit, setScopeEdit] = useState(null); // { faculty, all, departments:Set }
  const [linkDialog, setLinkDialog] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getFacultyList(filters));
      setError('');
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { getAdminDepartments().then((d) => setDepartments(d.filter((x) => x.is_active))).catch(() => {}); }, []);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 5000); };
  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: v, page: 1 }));
  const pages = Math.max(1, Math.ceil(data.total / data.limit));

  const openCreate = () => { setFormError(''); setForm({ mode: 'create', values: { ...emptyForm, department: departments[0]?.code || '' } }); };
  const openEdit = (f) => {
    setFormError('');
    setForm({ mode: 'edit', id: f.id, email: f.email, values: { faculty_id: f.employee_id || '', name: f.name, email: f.email, department: f.department || '', designation: f.designation || '' } });
  };
  const setVal = (k, v) => setForm((s) => ({ ...s, values: { ...s.values, [k]: v } }));

  const submitForm = async (e) => {
    e.preventDefault();
    setSaving(true); setFormError('');
    try {
      if (form.mode === 'create') {
        const r = await createFaculty(form.values);
        flash(`${r.faculty.name} was added as Invited. ${r.invitation.note}`);
      } else {
        const { email, ...rest } = form.values; // email is the login identity and cannot be edited
        await updateFaculty(form.id, rest);
        flash('Faculty details updated.');
      }
      setForm(null); load(); onChanged?.();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  };

  const openScope = (f) => setScopeEdit({ faculty: f, all: f.scope.all, departments: new Set(f.scope.departments), error: '' });
  const toggleDept = (name) => setScopeEdit((s) => {
    const next = new Set(s.departments);
    if (next.has(name)) next.delete(name); else next.add(name);
    return { ...s, departments: next };
  });
  const saveScope = async () => {
    setSaving(true);
    try {
      await setFacultyScope(scopeEdit.faculty.id, scopeEdit.all ? { all: true } : { departments: [...scopeEdit.departments] });
      flash(`Verification scope updated for ${scopeEdit.faculty.name}.`);
      setScopeEdit(null); load();
    } catch (err) { setScopeEdit((s) => ({ ...s, error: err.message })); } finally { setSaving(false); }
  };

  const issueLink = async (f) => {
    try { setLinkDialog({ user: f, ...(await createUserLink(f.id, 'HANDOFF')) }); } catch (e) { setError(e.message); }
  };
  const toggleStatus = async (f) => {
    try {
      await setAdminUserStatus(f.id, f.status !== 'ACTIVE');
      flash(f.status === 'ACTIVE' ? `${f.name} was suspended.` : `${f.name} was reactivated.`);
      load(); onChanged?.();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {[['list', 'Faculty accounts'], ['import', 'Import from CSV']].map(([id, label]) => (
          <button key={id} onClick={() => setView(id)}
            className={`rounded-xl px-3 py-1.5 text-[11px] font-bold ${view === id ? 'bg-brand-soft text-brand-text' : 'text-ink-secondary hover:text-ink-strong'}`}>{label}</button>
        ))}
      </div>

      {view === 'import' && <RosterImport kind="faculty" />}

      {view === 'list' && (
        <div className="card shadow-card">
          <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5">
            <div>
              <p className="eyebrow">Faculty</p>
              <h2 className="section-title mt-1">Faculty accounts and verification scope</h2>
              <p className="mt-1 text-xs text-ink-secondary">A reviewer only sees and decides activities of students inside their scope.</p>
            </div>
            <button className="btn-primary px-4 py-2 text-xs" onClick={openCreate} data-testid="add-faculty">Add faculty</button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2 px-5">
            <input className="field max-w-xs" placeholder="Search name, email or faculty ID" aria-label="Search faculty"
              value={filters.search} onChange={(e) => setFilter('search', e.target.value)} />
            <select className="field max-w-[220px]" aria-label="Department" value={filters.department} onChange={(e) => setFilter('department', e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => <option key={d.code} value={d.name}>{d.name}</option>)}
            </select>
            <select className="field max-w-[160px]" aria-label="Account status" value={filters.account_status} onChange={(e) => setFilter('account_status', e.target.value)}>
              <option value="">Any status</option>
              <option value="ACTIVE">Active</option><option value="INVITED">Invited</option><option value="SUSPENDED">Suspended</option>
            </select>
          </div>

          {notice && <div role="status" className="mx-5 mt-4 rounded-xl border border-emerald-200 bg-success-soft p-3 text-xs font-semibold text-emerald-900">{notice}</div>}
          {error && <div role="alert" className="mx-5 mt-4 rounded-xl border border-rose-200 bg-danger-soft p-3 text-xs font-semibold text-danger-text">{error}</div>}

          {loading ? (
            <p className="px-5 py-10 text-center text-xs text-ink-secondary">Loading…</p>
          ) : data.faculty.length === 0 ? (
            <p className="px-5 py-10 text-center text-xs text-ink-secondary">No faculty found.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-xs" data-testid="faculty-table">
                <thead className="bg-surface-alt text-[11px] uppercase text-ink-secondary">
                  <tr><th className="px-5 py-2">Faculty</th><th className="px-3 py-2">ID / Department</th><th className="px-3 py-2">Verification scope</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Actions</th></tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {data.faculty.map((f) => (
                    <tr key={f.id} data-testid={`faculty-row-${f.id}`}>
                      <td className="px-5 py-3">
                        <p className="font-bold text-ink-strong">{f.name}</p>
                        <p className="text-[11px] text-ink-secondary">{f.email}</p>
                        {f.designation && <p className="text-[11px] text-ink-secondary">{f.designation}</p>}
                      </td>
                      <td className="px-3 py-3"><p className="font-medium">{f.employee_id || '—'}</p><p className="text-[11px] text-ink-secondary">{f.department || '—'}</p></td>
                      <td className="px-3 py-3"><ScopeChips scope={f.scope} /></td>
                      <td className="px-3 py-3"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_STYLE[f.status]}`}>{f.status.charAt(0) + f.status.slice(1).toLowerCase()}</span></td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <button className="px-2 py-1 font-bold text-brand-text hover:underline" onClick={() => openEdit(f)}>Edit</button>
                        <button className="px-2 py-1 font-bold text-brand-text hover:underline" onClick={() => openScope(f)}>Scope</button>
                        {f.status !== 'SUSPENDED' && (
                          <button className="px-2 py-1 font-bold text-brand-text hover:underline" onClick={() => issueLink(f)}>{f.status === 'INVITED' ? 'Activation link' : 'Reset link'}</button>
                        )}
                        {f.status !== 'INVITED' && (
                          <button className={`px-2 py-1 font-bold hover:underline ${f.status === 'ACTIVE' ? 'text-danger-text' : 'text-success-text'}`} onClick={() => toggleStatus(f)}>
                            {f.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between px-5 py-4 text-[11px] text-ink-secondary">
            <span>{data.total} faculty</span>
            <div className="flex items-center gap-2">
              <button className="btn-secondary px-3 py-1.5 text-[11px]" disabled={filters.page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}>Previous</button>
              <span>Page {filters.page} of {pages}</span>
              <button className="btn-secondary px-3 py-1.5 text-[11px]" disabled={filters.page >= pages} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>Next</button>
            </div>
          </div>
        </div>
      )}

      {form && (
        <Modal title={form.mode === 'create' ? 'Add faculty' : 'Edit faculty'} onClose={() => setForm(null)}>
          <form onSubmit={submitForm} className="mt-4 space-y-3">
            <div><label className="field-label" htmlFor="ff-id">Faculty ID</label><input id="ff-id" className="field" required value={form.values.faculty_id} onChange={(e) => setVal('faculty_id', e.target.value)} /></div>
            <div><label className="field-label" htmlFor="ff-name">Full name</label><input id="ff-name" className="field" required value={form.values.name} onChange={(e) => setVal('name', e.target.value)} /></div>
            <div>
              <label className="field-label" htmlFor="ff-email">Email</label>
              <input id="ff-email" type="email" className="field" required disabled={form.mode === 'edit'} value={form.values.email} onChange={(e) => setVal('email', e.target.value)} />
              {form.mode === 'edit' && <p className="mt-1 text-[11px] text-ink-secondary">Email is the login identity and cannot be changed here.</p>}
            </div>
            <div>
              <label className="field-label" htmlFor="ff-dept">Department</label>
              <select id="ff-dept" className="field" required value={form.values.department} onChange={(e) => setVal('department', e.target.value)}>
                <option value="" disabled>Select department</option>
                {departments.map((d) => <option key={d.code} value={d.name}>{d.name}</option>)}
              </select>
            </div>
            <div><label className="field-label" htmlFor="ff-desig">Designation (optional)</label><input id="ff-desig" className="field" value={form.values.designation} onChange={(e) => setVal('designation', e.target.value)} /></div>
            {form.mode === 'create' && <p className="text-[11px] text-ink-secondary">New faculty can verify their own department only. Change this later with Scope. The account starts as Invited with no password.</p>}
            {formError && <div role="alert" className="rounded-xl border border-rose-200 bg-danger-soft p-3 text-xs font-semibold text-danger-text">{formError}</div>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-secondary px-4 py-2 text-xs" onClick={() => setForm(null)}>Cancel</button>
              <button type="submit" className="btn-primary px-4 py-2 text-xs" disabled={saving}>{saving ? 'Saving…' : form.mode === 'create' ? 'Add faculty' : 'Save changes'}</button>
            </div>
          </form>
        </Modal>
      )}

      {scopeEdit && (
        <Modal title={`Verification scope: ${scopeEdit.faculty.name}`} onClose={() => setScopeEdit(null)}>
          <div className="mt-4 space-y-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-ink-strong">
              <input type="checkbox" checked={scopeEdit.all} onChange={(e) => setScopeEdit((s) => ({ ...s, all: e.target.checked }))} data-testid="scope-all" />
              All departments
            </label>
            <fieldset disabled={scopeEdit.all} className="space-y-2 disabled:opacity-50">
              <legend className="field-label">Or choose departments</legend>
              {departments.map((d) => (
                <label key={d.code} className="flex items-center gap-2 text-xs text-ink">
                  <input type="checkbox" checked={scopeEdit.departments.has(d.name)} onChange={() => toggleDept(d.name)} data-testid={`scope-dept-${d.code}`} />
                  {d.name}
                </label>
              ))}
            </fieldset>
            {!scopeEdit.all && scopeEdit.departments.size === 0 && (
              <p className="rounded-xl bg-amber-50 p-3 text-[11px] font-semibold text-amber-800">With nothing selected this faculty member cannot verify any student.</p>
            )}
            {scopeEdit.error && <div role="alert" className="rounded-xl border border-rose-200 bg-danger-soft p-3 text-xs font-semibold text-danger-text">{scopeEdit.error}</div>}
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-secondary px-4 py-2 text-xs" onClick={() => setScopeEdit(null)}>Cancel</button>
              <button className="btn-primary px-4 py-2 text-xs" onClick={saveScope} disabled={saving} data-testid="save-scope">{saving ? 'Saving…' : 'Save scope'}</button>
            </div>
          </div>
        </Modal>
      )}

      {linkDialog && <LinkModal user={linkDialog.user} purpose={linkDialog.purpose} link={linkDialog.link} expiresAt={linkDialog.expires_at} onClose={() => { setLinkDialog(null); load(); }} />}
    </div>
  );
}
