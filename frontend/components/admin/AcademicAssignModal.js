import { useEffect, useState } from 'react';
import { getAdminDepartments, getAdminProgrammes, getAdminSessions, assignAcademic } from '@/lib/api';

// Department / programme / year / semester of one student (faculty: department only).
// Only active departments and programmes are offered; the server enforces the same rule.
export default function AcademicAssignModal({ user, onClose, onSaved }) {
  const isStudent = user.role === 'student';
  const [lists, setLists] = useState({ departments: [], programmes: [], years: [] });
  const [form, setForm] = useState({ department: user.department || '', programme: user.programme || '', academic_year: user.academic_year || '', semester: user.semester || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([getAdminDepartments(), isStudent ? getAdminProgrammes() : Promise.resolve([]), isStudent ? getAdminSessions() : Promise.resolve([])])
      .then(([departments, programmes, years]) => setLists({
        departments: departments.filter((d) => d.is_active || d.name === user.department),
        programmes: programmes.filter((p) => p.is_active || p.name === user.programme),
        years: years.map((y) => y.name),
      }))
      .catch((e) => setError(e.message));
  }, [isStudent, user.department, user.programme]);

  const submit = async (e) => {
    e.preventDefault();
    const body = {};
    for (const k of isStudent ? ['department', 'programme', 'academic_year', 'semester'] : ['department']) {
      if (form[k] && String(form[k]) !== String(user[k] ?? '')) body[k] = form[k];
    }
    if (!Object.keys(body).length) { setError('Nothing to change.'); return; }
    setBusy(true); setError('');
    try { await assignAcademic(user.id, body); onSaved(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const years = [...new Set([...(user.academic_year ? [user.academic_year] : []), ...lists.years])];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Academic assignment" data-testid="assign-modal">
      <form onSubmit={submit} className="card card-pad max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="section-title">Academic assignment</h3>
            <p className="mt-0.5 break-all text-xs text-ink-secondary">{user.name} · {user.email}</p>
          </div>
          <button type="button" className="text-xs font-bold text-ink-secondary hover:text-ink-strong" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {error && <p role="alert" data-testid="assign-error" className="rounded-xl border border-rose-200 bg-danger-soft p-3 text-xs font-semibold text-danger-text">{error}</p>}
        <label className="block text-xs font-semibold text-ink-body">Department
          <select className="field mt-1" aria-label="Department" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
            <option value="">—</option>
            {lists.departments.map((d) => <option key={d.id} value={d.name}>{d.name}{d.is_active ? '' : ' (inactive)'}</option>)}
          </select>
        </label>
        {isStudent && (
          <>
            <label className="block text-xs font-semibold text-ink-body">Programme
              <select className="field mt-1" aria-label="Programme" value={form.programme} onChange={(e) => setForm({ ...form, programme: e.target.value })}>
                <option value="">—</option>
                {lists.programmes.map((p) => <option key={p.id} value={p.name}>{p.name}{p.is_active ? '' : ' (inactive)'}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-semibold text-ink-body">Academic year
                <select className="field mt-1" aria-label="Academic year" value={form.academic_year} onChange={(e) => setForm({ ...form, academic_year: e.target.value })}>
                  <option value="">—</option>
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </label>
              <label className="block text-xs font-semibold text-ink-body">Semester
                <select className="field mt-1" aria-label="Semester" value={form.semester} onChange={(e) => setForm({ ...form, semester: e.target.value })}>
                  <option value="">—</option>
                  {Array.from({ length: 10 }, (_, i) => String(i + 1)).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
          </>
        )}
        {!isStudent && <p className="text-[11px] text-ink-secondary">This is the faculty member&apos;s home department. Which students they may verify is controlled separately under Faculty → Scope.</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
