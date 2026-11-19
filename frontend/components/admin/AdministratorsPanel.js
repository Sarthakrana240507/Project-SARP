import { useCallback, useEffect, useState } from 'react';
import { getAdministrators, createAdministrator, setSuperAdmin, createUserLink } from '@/lib/api';
import LinkModal from '@/components/admin/LinkModal';

// Visible to Super Admins only. The server enforces the same rule; hiding the tab is convenience, not security.
export default function AdministratorsPanel({ currentUserId }) {
  const [admins, setAdmins] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [values, setValues] = useState({ name: '', email: '', super: false });
  const [saving, setSaving] = useState(false);
  const [linkDialog, setLinkDialog] = useState(null);

  const load = useCallback(async () => {
    try { setAdmins((await getAdministrators()).administrators); setError(''); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const flash = (m) => { setNotice(m); setTimeout(() => setNotice(''), 5000); };

  const add = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      const r = await createAdministrator(values);
      flash(`${r.administrator.name} was added as Invited. Create an activation link so they can set a password.`);
      setValues({ name: '', email: '', super: false }); load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  const toggleSuper = async (a) => {
    try { await setSuperAdmin(a.id, !a.is_super_admin); flash(a.is_super_admin ? `${a.name} is no longer a Super Admin.` : `${a.name} is now a Super Admin.`); load(); } catch (err) { setError(err.message); }
  };
  const issueLink = async (a) => {
    try { setLinkDialog({ user: a, ...(await createUserLink(a.id, 'HANDOFF')) }); } catch (err) { setError(err.message); }
  };

  return (
    <div className="space-y-6">
      <div className="card card-pad shadow-card">
        <p className="eyebrow">Super Admin</p>
        <h2 className="section-title mt-1">Add an administrator</h2>
        <p className="mt-1 text-xs text-ink-secondary">Only Super Admins can create administrators or change their access. Nobody can register as an administrator themselves.</p>
        <form onSubmit={add} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <div><label className="field-label" htmlFor="ad-name">Full name</label><input id="ad-name" className="field" required value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} /></div>
          <div><label className="field-label" htmlFor="ad-email">Email</label><input id="ad-email" type="email" className="field" required value={values.email} onChange={(e) => setValues({ ...values, email: e.target.value })} /></div>
          <label className="flex items-center gap-2 pb-2.5 text-xs font-semibold text-ink-strong"><input type="checkbox" checked={values.super} onChange={(e) => setValues({ ...values, super: e.target.checked })} />Super Admin</label>
          <button type="submit" className="btn-primary px-4 py-2.5 text-xs" disabled={saving}>{saving ? 'Adding…' : 'Add administrator'}</button>
        </form>
        {notice && <div role="status" className="mt-4 rounded-xl border border-emerald-200 bg-success-soft p-3 text-xs font-semibold text-emerald-900">{notice}</div>}
        {error && <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-danger-soft p-3 text-xs font-semibold text-danger-text">{error}</div>}
      </div>

      <div className="card shadow-card">
        <div className="px-5 pt-5"><h2 className="section-title">Administrators</h2></div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="admins-table">
            <thead className="bg-surface-alt text-[11px] uppercase text-ink-secondary">
              <tr><th className="px-5 py-2">Administrator</th><th className="px-3 py-2">Access</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {admins.map((a) => {
                const isSelf = a.id === currentUserId;
                return (
                  <tr key={a.id}>
                    <td className="px-5 py-3"><p className="font-bold text-ink-strong">{a.name}{isSelf ? ' (You)' : ''}</p><p className="text-[11px] text-ink-secondary">{a.email}</p></td>
                    <td className="px-3 py-3">{a.is_super_admin ? <span className="rounded-full bg-navy px-2 py-0.5 text-[10px] font-bold text-white">Super Admin</span> : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700">Administrator</span>}</td>
                    <td className="px-3 py-3">{a.status.charAt(0) + a.status.slice(1).toLowerCase()}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {!isSelf && a.status !== 'SUSPENDED' && <button className="px-2 py-1 font-bold text-brand-text hover:underline" onClick={() => issueLink(a)}>{a.status === 'INVITED' ? 'Activation link' : 'Reset link'}</button>}
                      {!isSelf && <button className="px-2 py-1 font-bold text-brand-text hover:underline" onClick={() => toggleSuper(a)}>{a.is_super_admin ? 'Remove Super Admin' : 'Make Super Admin'}</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {linkDialog && <LinkModal user={linkDialog.user} purpose={linkDialog.purpose} link={linkDialog.link} expiresAt={linkDialog.expires_at} onClose={() => { setLinkDialog(null); load(); }} />}
    </div>
  );
}
