import Head from 'next/head';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import Avatar from '@/components/Avatar';
import ThemeSelector from '@/components/ThemeSelector';
import { useTheme } from '@/lib/theme';
import { getProfile, updateProfile, changePassword, getUser, saveSession, uploadProfilePhoto, removeProfilePhoto, MAX_PHOTO_BYTES, PHOTO_TYPES } from '@/lib/api';

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // Profile Edit State
  // Only the display name is user-editable. Student ID, department and academic
  // details are managed by the administrator and shown read-only.
  const [editForm, setEditForm] = useState({ name: '' });
  const [profileMsg, setProfileMsg] = useState({ type: '', text: '' });
  const [savingProfile, setSavingProfile] = useState(false);

  // Password Change State
  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: '',
  });
  const [pwdMsg, setPwdMsg] = useState({ type: '', text: '' });
  const [changingPwd, setChangingPwd] = useState(false);

  // Profile photo: choose -> preview -> save. Nothing is uploaded until "Save photo".
  const theme = useTheme();
  const fileInput = useRef(null);
  const [pending, setPending] = useState(null); // { file, url }
  const [photoMsg, setPhotoMsg] = useState({ type: '', text: '' });
  const [photoBusy, setPhotoBusy] = useState(false);

  const clearPending = () => {
    setPending((p) => { if (p) URL.revokeObjectURL(p.url); return null; });
    if (fileInput.current) fileInput.current.value = '';
  };

  const chooseFile = (e) => {
    const file = e.target.files?.[0];
    setPhotoMsg({ type: '', text: '' });
    if (!file) return;
    if (!PHOTO_TYPES.includes(file.type)) { setPhotoMsg({ type: 'error', text: 'Choose a JPG, JPEG, PNG or WEBP image.' }); e.target.value = ''; return; }
    if (file.size > MAX_PHOTO_BYTES) { setPhotoMsg({ type: 'error', text: 'That photo is larger than 5 MB. Choose a smaller one.' }); e.target.value = ''; return; }
    setPending((p) => { if (p) URL.revokeObjectURL(p.url); return { file, url: URL.createObjectURL(file) }; });
  };

  const syncPhoto = (res) => {
    const next = { ...profile, has_photo: res.has_photo, photo_version: res.photo_version };
    setProfile(next);
    saveSession({ user: { ...(getUser() || {}), has_photo: res.has_photo, photo_version: res.photo_version } });
  };

  const savePhoto = async () => {
    if (!pending) return;
    setPhotoBusy(true); setPhotoMsg({ type: '', text: '' });
    try {
      const res = await uploadProfilePhoto(pending.file);
      syncPhoto(res); clearPending();
      setPhotoMsg({ type: 'success', text: res.message });
    } catch (err) {
      setPhotoMsg({ type: 'error', text: err.message });
    } finally { setPhotoBusy(false); }
  };

  const deletePhoto = async () => {
    setPhotoBusy(true); setPhotoMsg({ type: '', text: '' });
    try {
      const res = await removeProfilePhoto();
      syncPhoto(res); clearPending();
      setPhotoMsg({ type: 'success', text: res.message });
    } catch (err) {
      setPhotoMsg({ type: 'error', text: err.message });
    } finally { setPhotoBusy(false); }
  };

  const loadProfile = useCallback(async () => {
    setLoading(true);
    try {
      const { user } = await getProfile();
      setProfile(user);
      setEditForm({ name: user.name || '' });
      // Keep the navbar in step with the server (e.g. a photo added from another device).
      const stored = getUser();
      if (stored && (stored.name !== user.name || stored.has_photo !== user.has_photo || stored.photo_version !== user.photo_version)) {
        saveSession({ user: { ...stored, name: user.name, has_photo: user.has_photo, photo_version: user.photo_version } });
      }
    } catch (err) {
      setProfileMsg({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getUser()) {
      router.push('/login');
      return;
    }
    loadProfile();
  }, [router, loadProfile]);

  const handleUpdateProfile = async (e) => {
    e.preventDefault();
    setProfileMsg({ type: '', text: '' });
    setSavingProfile(true);

    try {
      const res = await updateProfile({ name: editForm.name.trim() });

      setProfile(res.user);
      saveSession({ user: res.user });
      setProfileMsg({ type: 'success', text: 'Profile information updated successfully!' });
    } catch (err) {
      setProfileMsg({ type: 'error', text: err.message });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwdMsg({ type: '', text: '' });

    if (passwordForm.new_password !== passwordForm.confirm_password) {
      return setPwdMsg({ type: 'error', text: 'New passwords do not match.' });
    }
    if (passwordForm.new_password.length < 8) {
      return setPwdMsg({ type: 'error', text: 'New password must be at least 8 characters long.' });
    }

    setChangingPwd(true);
    try {
      await changePassword({
        current_password: passwordForm.current_password,
        new_password: passwordForm.new_password,
      });

      setPwdMsg({ type: 'success', text: 'Password changed successfully.' });
      setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });
    } catch (err) {
      setPwdMsg({ type: 'error', text: err.message });
    } finally {
      setChangingPwd(false);
    }
  };

  return (
    <>
      <Head>
        <title>SARP — User Profile & Security</title>
      </Head>
      <div className="min-h-screen bg-canvas">

        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="mb-6">
            <p className="eyebrow">Account Settings</p>
            <h1 className="page-header text-2xl">My Profile & Security</h1>
            <p className="mt-1 text-xs text-ink-secondary">
              Your account details and security.
            </p>
          </div>

          {loading ? (
            <div className="card card-pad text-center py-16 text-sm text-ink-secondary">
              Loading user profile credentials…
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Profile Overview Card */}
              <div className="card card-pad space-y-5 lg:col-span-1">
                <div className="border-b border-line-soft pb-4">
                  <div className="flex items-center gap-4">
                    {pending ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img data-testid="photo-preview" src={pending.url} alt="Preview of the new profile photo" className="h-20 w-20 shrink-0 rounded-full object-cover ring-2 ring-brand" />
                    ) : (
                      <Avatar user={profile} size={80} testId="profile-avatar" />
                    )}
                    <div className="min-w-0">
                      <h2 className="text-base font-bold text-ink-strong [overflow-wrap:anywhere]" data-testid="profile-name">{profile?.name}</h2>
                      <p className="text-xs text-ink-secondary capitalize">{profile?.role} Account</p>
                      <span data-testid="profile-status" className="mt-1 inline-block rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-bold text-success-text">
                        {profile?.status ? profile.status.charAt(0) + profile.status.slice(1).toLowerCase() : '—'}
                      </span>
                    </div>
                  </div>

                  <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" className="sr-only" id="photo-file" data-testid="photo-input" onChange={chooseFile} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {pending ? (
                      <>
                        <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={savePhoto} disabled={photoBusy} data-testid="photo-save">{photoBusy ? 'Saving…' : 'Save photo'}</button>
                        <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={clearPending} disabled={photoBusy} data-testid="photo-cancel">Cancel</button>
                      </>
                    ) : (
                      <>
                        <label htmlFor="photo-file" className="btn-secondary cursor-pointer px-3 py-1.5 text-xs" data-testid="photo-choose">{profile?.has_photo ? 'Replace photo' : 'Upload photo'}</label>
                        {profile?.has_photo && <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={deletePhoto} disabled={photoBusy} data-testid="photo-remove">Remove</button>}
                      </>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] text-ink-secondary">JPG, PNG or WEBP, up to 5 MB.</p>
                  {photoMsg.text && (
                    <p role={photoMsg.type === 'error' ? 'alert' : 'status'} data-testid="photo-message" className={`mt-2 rounded-lg border px-3 py-2 text-xs ${photoMsg.type === 'success' ? 'border-emerald-200 bg-success-soft text-emerald-800' : 'border-rose-200 bg-danger-soft text-rose-800'}`}>{photoMsg.text}</p>
                  )}
                </div>

                <div className="space-y-3 text-xs">
                  <div>
                    <span className="text-ink-secondary">Registered Email</span>
                    <p className="font-semibold text-ink-strong">{profile?.email}</p>
                  </div>
                  {profile?.role === 'student' && (
                    <div>
                      <span className="text-ink-secondary">Enrollment / Student ID</span>
                      <p className="font-semibold text-ink-strong">{profile?.enrollment_no || 'Not registered'}</p>
                    </div>
                  )}
                  {profile?.role === 'faculty' && (
                    <>
                      <div>
                        <span className="text-ink-secondary">Faculty ID</span>
                        <p className="font-semibold text-ink-strong">{profile?.employee_id || 'Not registered'}</p>
                      </div>
                      {profile?.designation && (
                        <div>
                          <span className="text-ink-secondary">Designation</span>
                          <p className="font-semibold text-ink-strong">{profile.designation}</p>
                        </div>
                      )}
                      <div data-testid="profile-scope">
                        <span className="text-ink-secondary">Verification scope</span>
                        <p className="font-semibold text-ink-strong">
                          {profile?.verification_scope?.all
                            ? 'All departments'
                            : profile?.verification_scope?.departments?.length
                              ? profile.verification_scope.departments.join(', ')
                              : 'None assigned'}
                        </p>
                      </div>
                    </>
                  )}
                  {profile?.role === 'admin' && (
                    <div>
                      <span className="text-ink-secondary">Access level</span>
                      <p className="font-semibold text-ink-strong">{profile?.is_super_admin ? 'Super Admin' : 'Administrator'}</p>
                    </div>
                  )}
                  <div>
                    <span className="text-ink-secondary">Department</span>
                    <p className="font-semibold text-ink-strong">
                      {profile?.department || 'Unassigned'}
                    </p>
                  </div>
                  {profile?.role === 'student' && (
                    <>
                      <div>
                        <span className="text-ink-secondary">Programme</span>
                        <p className="font-semibold text-ink-strong">{profile?.programme || 'Not specified'}</p>
                      </div>
                      <div>
                        <span className="text-ink-secondary">Academic Year</span>
                        <p className="font-semibold text-ink-strong">
                          {profile?.academic_year || 'Not specified'}
                        </p>
                      </div>
                      <div>
                        <span className="text-ink-secondary">Current Semester</span>
                        <p className="font-semibold text-ink-strong">
                          Semester {profile?.semester || '—'}
                        </p>
                      </div>
                    </>
                  )}
                  <div>
                    <span className="text-ink-secondary">Member Since</span>
                    <p className="font-semibold text-ink-strong">
                      {profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : '—'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Forms Section */}
              <div className="lg:col-span-2 space-y-6">
                {/* Edit Profile Form */}
                <form onSubmit={handleUpdateProfile} className="card card-pad space-y-4">
                  <div className="border-b border-line-soft pb-3">
                    <h2 className="section-title text-base">Edit Profile</h2>
                    <p className="text-xs text-ink-secondary">
                      Student ID, department and academic details are managed by your administrator.
                    </p>
                  </div>

                  {profileMsg.text && (
                    <div
                      className={`rounded-xl p-3 text-xs border ${
                        profileMsg.type === 'success'
                          ? 'border-emerald-200 bg-success-soft text-emerald-800'
                          : 'border-rose-200 bg-danger-soft text-rose-800'
                      }`}
                    >
                      {profileMsg.text}
                    </div>
                  )}

                  <div>
                    <label className="field-label">Full Name</label>
                    <input
                      className="field"
                      value={editForm.name}
                      maxLength={100}
                      onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      required
                    />
                  </div>

                  <div className="pt-2 text-right">
                    <button
                      type="submit"
                      disabled={savingProfile}
                      className="btn-primary py-2 px-5 text-xs font-bold"
                    >
                      {savingProfile ? 'Saving Changes…' : 'Save Profile Changes'}
                    </button>
                  </div>
                </form>

                {/* Appearance */}
                <section className="card card-pad space-y-3" data-testid="appearance-card">
                  <div className="border-b border-line-soft pb-3">
                    <h2 className="section-title text-base">Appearance</h2>
                    <p className="text-xs text-ink-secondary">
                      Choose light or dark, or let SARP follow your device. Your choice is remembered on this device and on your account.
                    </p>
                  </div>
                  <ThemeSelector testId="appearance-theme" />
                  <p className="text-[11px] text-ink-secondary" data-testid="appearance-status">
                    {theme.preference === 'system'
                      ? `Following your device — currently ${theme.resolved}.`
                      : `Always ${theme.preference}.`}
                  </p>
                </section>

                {/* Change Password Form */}
                <form onSubmit={handleChangePassword} className="card card-pad space-y-4">
                  <div className="border-b border-line-soft pb-3">
                    <h2 className="section-title text-base">Change Password</h2>
                    <p className="text-xs text-ink-secondary">
                      Ensure your account uses a secure, modern password.
                    </p>
                  </div>

                  {pwdMsg.text && (
                    <div
                      className={`rounded-xl p-3 text-xs border ${
                        pwdMsg.type === 'success'
                          ? 'border-emerald-200 bg-success-soft text-emerald-800'
                          : 'border-rose-200 bg-danger-soft text-rose-800'
                      }`}
                    >
                      {pwdMsg.text}
                    </div>
                  )}

                  <div>
                    <label className="field-label">Current Password</label>
                    <input
                      type="password"
                      className="field"
                      placeholder="••••••••"
                      value={passwordForm.current_password}
                      onChange={(e) =>
                        setPasswordForm({ ...passwordForm, current_password: e.target.value })
                      }
                      required
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="field-label">New Password</label>
                      <input
                        type="password"
                        className="field"
                        placeholder="At least 8 characters"
                        value={passwordForm.new_password}
                        onChange={(e) =>
                          setPasswordForm({ ...passwordForm, new_password: e.target.value })
                        }
                        required
                        minLength={8}
                      />
                    </div>

                    <div>
                      <label className="field-label">Confirm New Password</label>
                      <input
                        type="password"
                        className="field"
                        placeholder="Re-enter new password"
                        value={passwordForm.confirm_password}
                        onChange={(e) =>
                          setPasswordForm({ ...passwordForm, confirm_password: e.target.value })
                        }
                        required
                        minLength={8}
                      />
                    </div>
                  </div>

                  <div className="pt-2 text-right">
                    <button
                      type="submit"
                      disabled={changingPwd}
                      className="btn-primary py-2 px-5 text-xs font-bold"
                    >
                      {changingPwd ? 'Updating Password…' : 'Update Password'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}

