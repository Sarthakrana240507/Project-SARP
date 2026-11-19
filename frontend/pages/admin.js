import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import RosterImport from '@/components/admin/RosterImport';
import FacultyManager from '@/components/admin/FacultyManager';
import AdministratorsPanel from '@/components/admin/AdministratorsPanel';
import LinkModal from '@/components/admin/LinkModal';
import AcademicManager from '@/components/admin/AcademicManager';
import AuditLogPanel from '@/components/admin/AuditLogPanel';
import SupportManager from '@/components/admin/SupportManager';
import { ADMIN_TAB_IDS } from '@/components/shell/AppShell';
import AcademicAssignModal from '@/components/admin/AcademicAssignModal';
import {
  getUser,
  getProfile,
  saveSession,
  getToken,
  getAdminOverview,
  getAdminUsers,
  setAdminUserStatus,
  setAdminUserRole,
  createUserLink,
} from '@/lib/api';

export default function AdminControlPanel() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState(null);
  // The active section lives in the URL (?tab=...) and is chosen from the sidebar.
  const activeTab = ADMIN_TAB_IDS.includes(router.query.tab) ? router.query.tab : 'overview';
  const setActiveTab = (id) => router.push({ pathname: '/admin', query: { tab: id } }, undefined, { shallow: true });
  const [linkDialog, setLinkDialog] = useState(null); // one-time link shown to the admin once
  const [assignUser, setAssignUser] = useState(null); // user whose department / programme is being changed

  const [overview, setOverview] = useState(null);
  const [loadingOverview, setLoadingOverview] = useState(true);

  // Users Tab
  const [users, setUsers] = useState([]);
  const [userFilters, setUserFilters] = useState({ search: '', role: 'all', status: 'all' });
  const [loadingUsers, setLoadingUsers] = useState(false);

  // Categories Tab

  // Academic Sessions & Departments Tab

  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const token = getToken();
    const u = getUser();
    if (!token || !u) {
      router.replace('/login');
      return;
    }
    if (u.role !== 'admin') {
      router.replace('/dashboard');
      return;
    }
    setCurrentUser(u);
    // The stored copy can be stale (e.g. Super Admin access granted or removed since login).
    getProfile().then(({ user }) => {
      if (user.role !== 'admin') return router.replace('/dashboard');
      saveSession({ user });
      setCurrentUser(user);
    }).catch(() => {});
    loadOverviewData();
  }, [router]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 4500);
  };

  const loadOverviewData = async () => {
    setLoadingOverview(true);
    try {
      const data = await getAdminOverview();
      setOverview(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingOverview(false);
    }
  };

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      const data = await getAdminUsers(userFilters);
      setUsers(data.users || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingUsers(false);
    }
  };

  useEffect(() => {
    if (!currentUser) return;
    if (activeTab === 'users') loadUsers();
  }, [activeTab, userFilters]);

  // Actions
  const handleIssueLink = async (u) => {
    try {
      const r = await createUserLink(u.id, 'HANDOFF');
      setLinkDialog({ user: u, ...r });
    } catch (err) {
      setError(err.message);
    }
  };

  const handleToggleUserStatus = async (userId, currentStatus) => {
    try {
      await setAdminUserStatus(userId, !currentStatus);
      showToast(`User status updated.`);
      loadUsers();
      loadOverviewData();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    try {
      await setAdminUserRole(userId, newRole);
      showToast(`User role updated to ${newRole}.`);
      loadUsers();
      loadOverviewData();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!currentUser) return null;

  return (
    <>
      <Head>
        <title>SARP — Admin Control Panel</title>
      </Head>
      <div className="min-h-screen bg-canvas">

        <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
          {/* Header Banner */}
          <div className="rounded-2xl border border-brand-line bg-gradient-to-r from-brand-soft via-surface to-accent-soft p-6 shadow-sm sm:p-7">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
              <div>
                <div className="flex items-center gap-2">
                  <span className="flex h-6 items-center rounded-md bg-navy px-2 text-[10px] font-bold uppercase tracking-wider text-white">
                    Administrator
                  </span>
                  <span className="text-xs font-semibold text-ink-secondary">Institutional Governance</span>
                </div>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink-strong sm:text-3xl">
                  Admin Control Panel
                </h1>
                <p className="mt-1 text-xs text-ink-secondary sm:text-sm">
                  User account administration, taxonomy configuration, academic sessions, and institutional integrity management.
                </p>
              </div>

              <div className="flex items-center gap-2.5">
                <Link href="/analytics" className="btn-secondary py-2 text-xs font-bold">
                  View Analytics & Reports →
                </Link>
                <Link href="/faculty" className="btn-secondary py-2 text-xs font-bold">
                  Verification Queue →
                </Link>
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-5 rounded-xl border border-rose-200 bg-danger-soft p-4 text-xs font-semibold text-danger-text">
              ✕ {error}
            </div>
          )}

          {/* TAB 1: OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="mt-6 space-y-6">
              {loadingOverview ? (
                <div className="card p-12 text-center text-xs text-ink-secondary">Loading system metrics…</div>
              ) : (
                <>
                  <div data-testid="overview-tiles" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <StatBox id="students" label="Total Students" value={overview?.users?.total_students ?? 0} sub={`${overview?.users?.deactivated_users ?? 0} suspended accounts`} color="border-l-brand" />
                    <StatBox id="faculty" label="Total Faculty" value={overview?.users?.total_faculty ?? 0} sub="Verification accounts" color="border-l-brand" />
                    <StatBox id="activities" label="Total Activities" value={overview?.activities?.total_activities ?? 0} sub={`${overview?.activities?.drafts ?? 0} private drafts not counted`} color="border-l-accent" />
                    <StatBox id="pending" label="Pending Submissions" value={overview?.activities?.pending ?? 0} sub={`${overview?.activities?.resubmitted ?? 0} of them resubmitted`} color="border-l-amber-500" />
                    <StatBox id="approved" label="Approved" value={overview?.activities?.approved ?? 0} sub="Verified records" color="border-l-emerald-500" />
                    <StatBox id="rejected" label="Rejected" value={overview?.activities?.rejected ?? 0} sub="Declined with remarks" color="border-l-rose-500" />
                    <StatBox id="corrections" label="Correction Requests" value={overview?.activities?.correction_requested ?? 0} sub="Waiting for the student" color="border-l-orange-500" />
                    <StatBox id="duplicates" label="Duplicate Evidence Flags" value={overview?.duplicate_flags ?? 0} sub="Same file seen before: for manual inspection" color="border-l-yellow-600" />
                  </div>

                  <div className="grid gap-6 lg:grid-cols-2">
                    <div className="card card-pad">
                      <h2 className="section-title text-sm">Institutional Security & Verification Engine</h2>
                      <p className="mt-1 text-xs text-ink-secondary">Platform integrity measures active in SARP:</p>
                      <ul className="mt-4 space-y-2.5 text-xs text-ink">
                        <li className="flex items-center gap-2">
                          <span className="text-success-text font-bold">✓</span>
                          <span><strong>MIME Magic Bytes Validation:</strong> Binary file signatures inspected to block spoofed extensions.</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-success-text font-bold">✓</span>
                          <span><strong>Deterministic SHA-256 Hash Digest:</strong> Detects identical files across student submissions.</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-success-text font-bold">✓</span>
                          <span><strong>Protected File Storage:</strong> Proofs served exclusively via authenticated streams outside web root.</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-success-text font-bold">✓</span>
                          <span><strong>Atomic DB Transactions:</strong> Approval/rejection workflows locked with PostgreSQL row-level locks.</span>
                        </li>
                      </ul>
                    </div>

                    <div className="card card-pad">
                      <h2 className="section-title text-sm">Quick Governance Actions</h2>
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        <button
                          onClick={() => setActiveTab('users')}
                          className="btn-secondary p-3 text-left block"
                        >
                          <p className="font-bold text-ink-strong text-xs">Manage Users</p>
                          <p className="text-[11px] text-ink-secondary mt-0.5">Activate, deactivate, change roles</p>
                        </button>
                        <button
                          onClick={() => setActiveTab('academic')}
                          className="btn-secondary p-3 text-left block"
                        >
                          <p className="font-bold text-ink-strong text-xs">Academic Setup</p>
                          <p className="text-[11px] text-ink-secondary mt-0.5">Departments, programmes, years, categories</p>
                        </button>
                        <Link href="/analytics" className="btn-secondary p-3 text-left block">
                          <p className="font-bold text-ink-strong text-xs">Analytics Reports</p>
                          <p className="text-[11px] text-ink-secondary mt-0.5">Export CSV & PDF audit summaries</p>
                        </Link>
                        <Link href="/faculty" className="btn-secondary p-3 text-left block">
                          <p className="font-bold text-ink-strong text-xs">Verification Center</p>
                          <p className="text-[11px] text-ink-secondary mt-0.5">Inspect pending submissions</p>
                        </Link>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* TAB 2: USER MANAGEMENT */}
          {activeTab === 'users' && (
            <div className="mt-6 card overflow-hidden">
              <div className="border-b border-line p-5 sm:p-6 bg-surface">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <h2 className="section-title text-base">User Directory & Permissions</h2>
                    <p className="text-xs text-ink-secondary">
                      Search accounts, manage active access status, and assign institutional roles.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="field text-xs py-1.5 max-w-[180px]"
                      placeholder="Search users…"
                      value={userFilters.search}
                      onChange={(e) => setUserFilters({ ...userFilters, search: e.target.value })}
                    />
                    <select
                      className="field text-xs py-1.5 w-auto"
                      value={userFilters.role}
                      onChange={(e) => setUserFilters({ ...userFilters, role: e.target.value })}
                    >
                      <option value="all">All Roles</option>
                      <option value="student">Students</option>
                      <option value="faculty">Faculty</option>
                      <option value="admin">Admins</option>
                    </select>
                    <select
                      className="field text-xs py-1.5 w-auto"
                      value={userFilters.status}
                      onChange={(e) => setUserFilters({ ...userFilters, status: e.target.value })}
                    >
                      <option value="all">All Statuses</option>
                      <option value="active">Active Only</option>
                      <option value="inactive">Suspended Only</option>
                      <option value="invited">Invited Only</option>
                    </select>
                  </div>
                </div>
              </div>

              {loadingUsers ? (
                <div className="p-12 text-center text-xs text-ink-secondary">Loading users…</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-surface-alt border-b border-line text-ink-secondary uppercase text-[10px] font-bold">
                      <tr>
                        <th className="px-5 py-3">User</th>
                        <th className="px-4 py-3">Enrollment / Dept / Programme</th>
                        <th className="px-4 py-3">Role</th>
                        <th className="px-4 py-3">Account Status</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      {users.map((u) => {
                        const isSelf = u.id === currentUser.id;
                        return (
                          <tr key={u.id} className="hover:bg-surface-alt transition">
                            <td className="px-5 py-3.5">
                              <p className="font-bold text-ink-strong">{u.name}</p>
                              <p className="text-[11px] text-ink-secondary">{u.email}</p>
                            </td>
                            <td className="px-4 py-3.5 text-ink">
                              <p className="font-medium">{u.enrollment_no || '—'}</p>
                              <p className="text-[11px] text-ink-secondary">{u.department || 'Unassigned'}{u.programme ? ` · ${u.programme}` : ''}</p>
                            </td>
                            <td className="px-4 py-3.5">
                              {isSelf || (u.role === 'admin' && !currentUser.is_super_admin) ? (
                                <span className="rounded-full bg-slate-100 border border-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-700 uppercase">
                                  {u.role}{isSelf ? ' (You)' : ''}
                                </span>
                              ) : (
                                <select
                                  value={u.role}
                                  onChange={(e) => handleRoleChange(u.id, e.target.value)}
                                  className="rounded-lg border border-line bg-surface px-2 py-1 text-[11px] font-semibold text-ink-strong"
                                >
                                  <option value="student">Student</option>
                                  <option value="faculty">Faculty</option>
                                  <option value="admin" disabled={!currentUser.is_super_admin}>Admin</option>
                                </select>
                              )}
                            </td>
                            <td className="px-4 py-3.5">
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                  u.status === 'ACTIVE'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : u.status === 'INVITED'
                                      ? 'bg-amber-100 text-amber-800'
                                      : 'bg-rose-100 text-rose-800'
                                }`}
                              >
                                {u.status === 'ACTIVE' ? 'Active' : u.status === 'INVITED' ? 'Invited' : 'Suspended'}
                              </span>
                            </td>
                            <td className="px-4 py-3.5 text-right">
                              {['student', 'faculty'].includes(u.role) && (
                                <button
                                  data-testid={`assign-${u.id}`}
                                  onClick={() => setAssignUser(u)}
                                  className="rounded-lg px-2.5 py-1 text-[11px] font-bold text-brand-text transition hover:bg-brand-soft"
                                >
                                  Academic
                                </button>
                              )}
                              {!isSelf && (u.role !== 'admin' || currentUser.is_super_admin) && u.status !== 'SUSPENDED' && (
                                <button
                                  onClick={() => handleIssueLink(u)}
                                  className="rounded-lg px-2.5 py-1 text-[11px] font-bold text-brand-text transition hover:bg-brand-soft"
                                >
                                  {u.status === 'INVITED' ? 'Activation link' : 'Reset link'}
                                </button>
                              )}
                              {!isSelf && (u.role !== 'admin' || currentUser.is_super_admin) && u.status !== 'INVITED' && (
                                <button
                                  onClick={() => handleToggleUserStatus(u.id, u.is_active !== false)}
                                  className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
                                    u.is_active !== false
                                      ? 'text-danger-text hover:bg-rose-50'
                                      : 'text-success-text hover:bg-emerald-50'
                                  }`}
                                >
                                  {u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === 'import' && <RosterImport kind="students" />}
          {activeTab === 'faculty' && <FacultyManager onChanged={loadOverviewData} />}
          {activeTab === 'administrators' && currentUser.is_super_admin && <AdministratorsPanel currentUserId={currentUser.id} />}

          {activeTab === 'academic' && <AcademicManager />}
          {activeTab === 'support' && <SupportManager />}
          {activeTab === 'audit' && <AuditLogPanel />}

        {assignUser && (
          <AcademicAssignModal
            user={assignUser}
            onClose={() => setAssignUser(null)}
            onSaved={() => { setAssignUser(null); showToast('Academic assignment updated.'); loadUsers(); loadOverviewData(); }}
          />
        )}
        {linkDialog && (
        <LinkModal user={linkDialog.user} purpose={linkDialog.purpose} link={linkDialog.link} expiresAt={linkDialog.expires_at} onClose={() => setLinkDialog(null)} />
      )}
      </main>

        {toast && (
          <div className="toast">
            <span className="text-accent-text font-bold">✓</span>
            <span>{toast}</span>
          </div>
        )}
      </div>
    </>
  );
}

function StatBox({ id, label, value, sub, color }) {
  return (
    <div data-testid={`tile-${id}`} className={`stat-card border-l-4 ${color}`}>
      <p data-testid={`tile-value-${id}`} className="text-3xl font-bold tracking-tight text-ink-strong">{value}</p>
      <p className="mt-1 text-xs font-bold uppercase tracking-wider text-ink-secondary">{label}</p>
      {sub && <p className="mt-2 text-[11px] text-ink-secondary border-t border-line-soft pt-2">{sub}</p>}
    </div>
  );
}

