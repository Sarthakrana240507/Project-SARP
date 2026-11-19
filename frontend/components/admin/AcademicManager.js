import { useCallback, useEffect, useState } from 'react';
import {
  getAdminDepartments, createAdminDepartment, updateAdminDepartment, setAdminDepartmentStatus,
  getAdminProgrammes, createAdminProgramme, updateAdminProgramme, setAdminProgrammeStatus,
  getAdminSessions, createAdminSession, updateAdminSession, setAdminSessionCurrent, archiveAdminSession,
  getAdminCategories, createAdminCategory, updateAdminCategory, toggleAdminCategory,
} from '@/lib/api';

// Nothing on this screen deletes anything. Old records keep pointing at departments, programmes, years and
// categories, so "remove" means deactivate (or close), and history stays readable.

const SECTIONS = [
  { id: 'departments', label: 'Departments' },
  { id: 'programmes', label: 'Programmes' },
  { id: 'years', label: 'Academic years & semesters' },
  { id: 'categories', label: 'Activity categories' },
];

const Badge = ({ on, yes = 'Active', no = 'Inactive' }) => (
  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${on ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-ink-body'}`}>{on ? yes : no}</span>
);

/** Loads a list and exposes a message line for success / error feedback. */
function useSection(loader) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null); // { kind: 'ok' | 'error', text }
  const reload = useCallback(async () => {
    try { setRows(await loader()); } catch (e) { setMessage({ kind: 'error', text: e.message }); } finally { setLoading(false); }
  }, [loader]);
  useEffect(() => { reload(); }, [reload]);
  const run = async (action, okText) => {
    setMessage(null);
    try { await action(); await reload(); setMessage({ kind: 'ok', text: okText }); return true; } catch (e) { setMessage({ kind: 'error', text: e.message }); return false; }
  };
  return { rows, loading, message, run };
}

const Message = ({ message }) => !message ? null : (
  <p role={message.kind === 'error' ? 'alert' : 'status'} data-testid="acad-message"
    className={`mt-3 rounded-xl border p-3 text-xs font-semibold ${message.kind === 'error' ? 'border-rose-200 bg-danger-soft text-danger-text' : 'border-emerald-200 bg-success-soft text-success-text'}`}>
    {message.text}
  </p>
);

const Th = ({ children, right }) => <th className={`px-4 py-3 ${right ? 'text-right' : ''}`}>{children}</th>;
const Table = ({ testid, head, children, empty }) => (
  <div className="mt-4 overflow-x-auto rounded-xl border border-line">
    <table data-testid={testid} className="w-full min-w-[560px] text-left text-xs">
      <thead className="bg-surface-alt text-[10px] font-bold uppercase tracking-wider text-ink-secondary"><tr>{head}</tr></thead>
      <tbody className="divide-y divide-line-soft">{children}</tbody>
    </table>
    {empty && <p className="p-6 text-center text-xs text-ink-secondary">Nothing here yet.</p>}
  </div>
);
const LinkBtn = ({ children, danger, ...rest }) => (
  <button type="button" {...rest} className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${danger ? 'text-danger-text hover:bg-rose-50' : 'text-brand-text hover:bg-brand-soft'}`}>{children}</button>
);

// ------------------------------------------------------------------ departments
function Departments() {
  const { rows, loading, message, run } = useSection(getAdminDepartments);
  const [form, setForm] = useState({ code: '', name: '' });
  const [editing, setEditing] = useState(null); // { id, code, name }
  return (
    <div data-testid="acad-departments">
      <form className="grid gap-2 sm:grid-cols-[140px_1fr_auto]" onSubmit={async (e) => { e.preventDefault(); if (await run(() => createAdminDepartment(form), 'Department added.')) setForm({ code: '', name: '' }); }}>
        <input className="field" aria-label="Department code" placeholder="Code (e.g. CSE)" maxLength={10} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <input className="field" aria-label="Department name" placeholder="Full name" maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <button className="btn-primary" type="submit">Add department</button>
      </form>
      <Message message={message} />
      <Table testid="departments-table" empty={!loading && rows.length === 0}
        head={<><Th>Code</Th><Th>Name</Th><Th>Students</Th><Th>Faculty</Th><Th>Status</Th><Th right>Actions</Th></>}>
        {rows.map((d) => (
          <tr key={d.id} data-testid={`department-${d.id}`}>
            {editing?.id === d.id ? (
              <>
                <td className="px-4 py-2"><input className="field" aria-label="Edit code" value={editing.code} maxLength={10} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></td>
                <td className="px-4 py-2" colSpan={4}>
                  <input className="field" aria-label="Edit name" value={editing.name} maxLength={100} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  <p className="mt-1 text-[10px] text-ink-secondary">Renaming also updates every student, faculty member and verification scope that uses this department.</p>
                </td>
                <td className="px-4 py-2 text-right">
                  <LinkBtn onClick={async () => { if (await run(() => updateAdminDepartment(d.id, { code: editing.code, name: editing.name }), 'Department updated.')) setEditing(null); }}>Save</LinkBtn>
                  <LinkBtn onClick={() => setEditing(null)}>Cancel</LinkBtn>
                </td>
              </>
            ) : (
              <>
                <td className="px-4 py-3 font-bold text-ink-strong">{d.code}</td>
                <td className="px-4 py-3">{d.name}</td>
                <td className="px-4 py-3">{d.student_count}</td>
                <td className="px-4 py-3">{d.faculty_count}</td>
                <td className="px-4 py-3"><Badge on={d.is_active} /></td>
                <td className="px-4 py-3 text-right">
                  <LinkBtn onClick={() => setEditing({ id: d.id, code: d.code, name: d.name })}>Edit</LinkBtn>
                  <LinkBtn danger={d.is_active} onClick={() => run(() => setAdminDepartmentStatus(d.id, !d.is_active), d.is_active ? 'Department deactivated. Existing records are unchanged.' : 'Department activated.')}>{d.is_active ? 'Deactivate' : 'Activate'}</LinkBtn>
                </td>
              </>
            )}
          </tr>
        ))}
      </Table>
    </div>
  );
}

// ------------------------------------------------------------------ programmes
function Programmes() {
  const { rows, loading, message, run } = useSection(getAdminProgrammes);
  const [form, setForm] = useState({ code: '', name: '' });
  const [editing, setEditing] = useState(null);
  return (
    <div data-testid="acad-programmes">
      <form className="grid gap-2 sm:grid-cols-[140px_1fr_auto]" onSubmit={async (e) => { e.preventDefault(); if (await run(() => createAdminProgramme(form), 'Programme added.')) setForm({ code: '', name: '' }); }}>
        <input className="field" aria-label="Programme code" placeholder="Code (e.g. BTECH)" maxLength={20} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <input className="field" aria-label="Programme name" placeholder="Name (e.g. BTech)" maxLength={50} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <button className="btn-primary" type="submit">Add programme</button>
      </form>
      <p className="mt-2 text-[11px] text-ink-secondary">Student CSV imports accept only programmes listed here (spelling such as “B.Tech” is matched automatically).</p>
      <Message message={message} />
      <Table testid="programmes-table" empty={!loading && rows.length === 0}
        head={<><Th>Code</Th><Th>Name</Th><Th>Students</Th><Th>Status</Th><Th right>Actions</Th></>}>
        {rows.map((p) => (
          <tr key={p.id} data-testid={`programme-${p.id}`}>
            {editing?.id === p.id ? (
              <>
                <td className="px-4 py-2"><input className="field" aria-label="Edit code" value={editing.code} maxLength={20} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></td>
                <td className="px-4 py-2" colSpan={3}><input className="field" aria-label="Edit name" value={editing.name} maxLength={50} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></td>
                <td className="px-4 py-2 text-right">
                  <LinkBtn onClick={async () => { if (await run(() => updateAdminProgramme(p.id, { code: editing.code, name: editing.name }), 'Programme updated.')) setEditing(null); }}>Save</LinkBtn>
                  <LinkBtn onClick={() => setEditing(null)}>Cancel</LinkBtn>
                </td>
              </>
            ) : (
              <>
                <td className="px-4 py-3 font-bold text-ink-strong">{p.code}</td>
                <td className="px-4 py-3">{p.name}</td>
                <td className="px-4 py-3">{p.student_count}</td>
                <td className="px-4 py-3"><Badge on={p.is_active} /></td>
                <td className="px-4 py-3 text-right">
                  <LinkBtn onClick={() => setEditing({ id: p.id, code: p.code, name: p.name })}>Edit</LinkBtn>
                  <LinkBtn danger={p.is_active} onClick={() => run(() => setAdminProgrammeStatus(p.id, !p.is_active), p.is_active ? 'Programme deactivated.' : 'Programme activated.')}>{p.is_active ? 'Deactivate' : 'Activate'}</LinkBtn>
                </td>
              </>
            )}
          </tr>
        ))}
      </Table>
    </div>
  );
}

// ------------------------------------------------------------------ academic years & semesters
function Years() {
  const { rows, loading, message, run } = useSection(getAdminSessions);
  const [form, setForm] = useState({ name: '', current_semester: '1', is_current: false });
  const [editing, setEditing] = useState(null); // { id, current_semester }
  return (
    <div data-testid="acad-years">
      <form className="grid gap-2 sm:grid-cols-[1fr_160px_auto_auto] sm:items-center" onSubmit={async (e) => { e.preventDefault(); if (await run(() => createAdminSession(form), 'Academic year added.')) setForm({ name: '', current_semester: '1', is_current: false }); }}>
        <input className="field" aria-label="Academic year" placeholder="Academic year, e.g. 2026-2027" maxLength={9} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className="field" aria-label="Current semester" value={form.current_semester} onChange={(e) => setForm({ ...form, current_semester: e.target.value })}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>Semester {n}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-body">
          <input type="checkbox" aria-label="Make current" checked={form.is_current} onChange={(e) => setForm({ ...form, is_current: e.target.checked })} /> Make current
        </label>
        <button className="btn-primary" type="submit">Add year</button>
      </form>
      <p className="mt-2 text-[11px] text-ink-secondary">Closing a year stops <em>new</em> submissions in it. Existing records, reviews and reports are kept, and older records can still be corrected and resubmitted.</p>
      <Message message={message} />
      <Table testid="years-table" empty={!loading && rows.length === 0}
        head={<><Th>Academic year</Th><Th>Current semester</Th><Th>Records</Th><Th>Status</Th><Th right>Actions</Th></>}>
        {rows.map((s) => (
          <tr key={s.id} data-testid={`year-${s.id}`}>
            <td className="px-4 py-3 font-bold text-ink-strong">{s.name}</td>
            <td className="px-4 py-3">
              {editing?.id === s.id ? (
                <select className="field" aria-label="Edit semester" value={editing.current_semester} onChange={(e) => setEditing({ ...editing, current_semester: e.target.value })}>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>Semester {n}</option>)}
                </select>
              ) : (s.current_semester_number ? `Semester ${s.current_semester_number}` : s.current_semester)}
            </td>
            <td className="px-4 py-3">{s.activity_count}</td>
            <td className="px-4 py-3">
              <div className="flex flex-wrap gap-1">
                {s.is_current && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand-strong">Current</span>}
                <Badge on={!s.is_archived} yes="Open" no="Closed" />
              </div>
            </td>
            <td className="px-4 py-3 text-right">
              {editing?.id === s.id ? (
                <>
                  <LinkBtn onClick={async () => { if (await run(() => updateAdminSession(s.id, { current_semester: editing.current_semester }), 'Semester updated.')) setEditing(null); }}>Save</LinkBtn>
                  <LinkBtn onClick={() => setEditing(null)}>Cancel</LinkBtn>
                </>
              ) : (
                <>
                  <LinkBtn onClick={() => setEditing({ id: s.id, current_semester: String(s.current_semester_number || 1) })}>Edit semester</LinkBtn>
                  {!s.is_current && !s.is_archived && <LinkBtn onClick={() => run(() => setAdminSessionCurrent(s.id), `${s.name} is now the current academic year.`)}>Make current</LinkBtn>}
                  {!s.is_current && <LinkBtn danger={!s.is_archived} onClick={() => run(() => archiveAdminSession(s.id, !s.is_archived), s.is_archived ? 'Academic year reopened.' : 'Academic year closed. Existing records are unchanged.')}>{s.is_archived ? 'Reopen' : 'Close'}</LinkBtn>}
                </>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

// ------------------------------------------------------------------ categories
function Categories() {
  const { rows, loading, message, run } = useSection(getAdminCategories);
  const [form, setForm] = useState({ name: '', display_name: '' });
  const [editing, setEditing] = useState(null);
  return (
    <div data-testid="acad-categories">
      <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={async (e) => { e.preventDefault(); if (await run(() => createAdminCategory(form), 'Category added.')) setForm({ name: '', display_name: '' }); }}>
        <input className="field" aria-label="Category identifier" placeholder="Identifier (e.g. research)" maxLength={40} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="field" aria-label="Category display name" placeholder="Display name" maxLength={60} value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
        <button className="btn-primary" type="submit">Add category</button>
      </form>
      <p className="mt-2 text-[11px] text-ink-secondary">The identifier is what existing activities are stored under, so only the display name can be changed. A deactivated category takes no new submissions but old records keep it.</p>
      <Message message={message} />
      <Table testid="categories-table" empty={!loading && rows.length === 0}
        head={<><Th>Identifier</Th><Th>Display name</Th><Th>Activities</Th><Th>Status</Th><Th right>Actions</Th></>}>
        {rows.map((c) => (
          <tr key={c.id} data-testid={`category-${c.id}`}>
            <td className="px-4 py-3 font-mono text-[11px] text-ink-body">{c.name}</td>
            <td className="px-4 py-3">
              {editing?.id === c.id
                ? <input className="field" aria-label="Edit display name" value={editing.display_name} maxLength={60} onChange={(e) => setEditing({ ...editing, display_name: e.target.value })} />
                : <span className="font-bold text-ink-strong">{c.display_name}</span>}
            </td>
            <td className="px-4 py-3">{c.usage_count}</td>
            <td className="px-4 py-3"><Badge on={c.is_active} /></td>
            <td className="px-4 py-3 text-right">
              {editing?.id === c.id ? (
                <>
                  <LinkBtn onClick={async () => { if (await run(() => updateAdminCategory(c.id, { display_name: editing.display_name }), 'Category renamed.')) setEditing(null); }}>Save</LinkBtn>
                  <LinkBtn onClick={() => setEditing(null)}>Cancel</LinkBtn>
                </>
              ) : (
                <>
                  <LinkBtn onClick={() => setEditing({ id: c.id, display_name: c.display_name })}>Rename</LinkBtn>
                  <LinkBtn danger={c.is_active} onClick={() => run(() => toggleAdminCategory(c.id, !c.is_active), c.is_active ? 'Category deactivated.' : 'Category activated.')}>{c.is_active ? 'Deactivate' : 'Activate'}</LinkBtn>
                </>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

export default function AcademicManager() {
  const [section, setSection] = useState('departments');
  return (
    <div className="mt-6 card card-pad" data-testid="academic-manager">
      <div className="flex flex-wrap gap-2 border-b border-line pb-3">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" data-testid={`acad-tab-${s.id}`} onClick={() => setSection(s.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${section === s.id ? 'bg-brand-soft text-ink-strong' : 'text-ink-secondary hover:text-ink-strong'}`}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {section === 'departments' && <Departments />}
        {section === 'programmes' && <Programmes />}
        {section === 'years' && <Years />}
        {section === 'categories' && <Categories />}
      </div>
    </div>
  );
}
