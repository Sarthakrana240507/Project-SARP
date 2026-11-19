import { adoptAccountPreference } from './theme';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

export function getToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

export function getUser() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(data) {
  if (typeof window === 'undefined') return;
  if (data?.token) localStorage.setItem('token', data.token);
  if (data?.user) {
    localStorage.setItem('user', JSON.stringify(data.user));
    // A sign-in response carries a token: take the account's saved appearance (or save this device's choice to it).
    if (data.token) adoptAccountPreference(data.user);
    // Lets the navbar and other open components show the new name or photo straight away.
    window.dispatchEvent(new Event('sarp:user'));
  }
}

export function logout() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

/**
 * Returns the primary landing route for a specific user role.
 */
export function getRoleHome(role) {
  switch (role) {
    case 'faculty':
      return '/faculty';
    case 'admin':
      return '/admin';
    case 'student':
    default:
      return '/dashboard';
  }
}

/**
 * Unified fetch wrapper with auth header injection, error parsing, and automatic 401 handling.
 */
export async function apiFetch(path, { method = 'GET', body, isForm = false, raw = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });

  if (raw) return res;

  const data = await res.json().catch(() => ({}));
  // A rejected session (expired/revoked token, suspended account) ends the local session
  // and returns to the login page. Failed sign-in attempts are excluded so their
  // error message stays visible on the login form.
  const sessionEnded =
    res.status === 401 || (res.status === 403 && ['ACCOUNT_SUSPENDED', 'ACCOUNT_NOT_ACTIVE'].includes(data.code));
  if (sessionEnded && token && path !== '/auth/login' && typeof window !== 'undefined') {
    logout();
    if (window.location.pathname !== '/login') {
      window.location.replace('/login?session=ended');
    }
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed with status ${res.status}`);
    err.status = res.status;
    err.fields = data.fields || null; // field-level messages from server-side validation
    throw err;
  }
  return data;
}

// -------------------------------------------------------------
// NOTIFICATIONS
// -------------------------------------------------------------
export async function getNotifications(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  const q = qs.toString();
  return apiFetch(`/notifications${q ? `?${q}` : ''}`);
}

export async function getUnreadNotificationCount() {
  return apiFetch('/notifications/unread-count');
}

export async function markNotificationRead(id) {
  return apiFetch(`/notifications/${id}/read`, { method: 'PATCH' });
}

export async function markAllNotificationsRead() {
  return apiFetch('/notifications/read-all', { method: 'PATCH' });
}

// -------------------------------------------------------------
// PROFILE & AUTH
// -------------------------------------------------------------
export async function getProfile() {
  return apiFetch('/auth/me');
}

export async function updateProfile(data) {
  return apiFetch('/auth/profile', { method: 'PUT', body: data });
}

export async function changePassword(data) {
  const res = await apiFetch('/auth/change-password', { method: 'PUT', body: data });
  // Changing the password revokes older tokens; keep this session alive with the new one.
  if (res?.token) saveSession({ token: res.token });
  return res;
}

// -------------------------------------------------------------
// ACTIVITIES & DRAFTS & CORRECTIONS
// -------------------------------------------------------------
// Student's own list. Every filter is applied by the server; the response is
// { activities, total, page, limit, pages, counts }.
export async function getActivities(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === 'all') continue;
    q.set(k, String(v));
  }
  const queryStr = q.toString() ? `?${q.toString()}` : '';
  return apiFetch(`/activities/mine${queryStr}`);
}

export const getActivityOptions = () => apiFetch('/activities/options');
export const getActivityVersions = (id) => apiFetch(`/activities/${id}/versions`);
export const deleteDraft = (id) => apiFetch(`/activities/${id}`, { method: 'DELETE' });

export async function getActivity(id) {
  return apiFetch(`/activities/${id}`);
}

export async function getActivityAudit(id) {
  return apiFetch(`/activities/${id}/audit`);
}

export async function createActivity(formData) {
  return apiFetch('/activities', { method: 'POST', body: formData, isForm: true });
}

export async function saveDraft(formData) {
  return apiFetch('/activities/draft', { method: 'POST', body: formData, isForm: true });
}

export async function updateDraft(id, formData) {
  return apiFetch(`/activities/${id}/draft`, { method: 'PUT', body: formData, isForm: true });
}

export async function submitDraft(id, formData = null) {
  return apiFetch(`/activities/${id}/submit-draft`, {
    method: 'POST',
    body: formData,
    isForm: Boolean(formData),
  });
}

export async function requestCorrection(id, notes, expectedVersion) {
  return apiFetch(`/activities/${id}/request-correction`, {
    method: 'PATCH',
    body: { notes, expected_version: expectedVersion },
  });
}

export async function resubmitActivity(id, formData) {
  return apiFetch(`/activities/${id}/resubmit`, {
    method: 'PUT',
    body: formData,
    isForm: true,
  });
}

// expectedVersion = the version the reviewer was looking at; the server refuses the decision if the student resubmitted since.
export async function approveActivity(id, remarks = '', expectedVersion) {
  return apiFetch(`/activities/${id}/approve`, {
    method: 'PATCH',
    body: { remarks, expected_version: expectedVersion },
  });
}

export async function rejectActivity(id, remarks, expectedVersion) {
  return apiFetch(`/activities/${id}/reject`, {
    method: 'PATCH',
    body: { remarks, expected_version: expectedVersion },
  });
}

// Reviewer lists: every filter is sent to the server (empty values and "all" are skipped).
const reviewQuery = (params = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === 'all' || v === false) continue;
    q.set(k, String(v));
  }
  return q.toString() ? `?${q.toString()}` : '';
};
export const getPendingActivities = (params) => apiFetch(`/activities/pending${reviewQuery(params)}`);
export const getReviewHistory = (params) => apiFetch(`/activities/history${reviewQuery(params)}`);
export const getReviewSummary = () => apiFetch('/activities/review/summary');

// -------------------------------------------------------------
// ADMIN CONTROLS
// -------------------------------------------------------------
export async function getAdminOverview() {
  return apiFetch('/admin/overview');
}

export async function getAdminUsers(params = {}) {
  const q = new URLSearchParams();
  if (params.role && params.role !== 'all') q.set('role', params.role);
  if (params.department && params.department !== 'all') q.set('department', params.department);
  // The dropdown values map to the backend's account_status filter.
  const statusMap = { active: 'ACTIVE', inactive: 'SUSPENDED', invited: 'INVITED' };
  if (statusMap[params.status]) q.set('account_status', statusMap[params.status]);
  if (params.search) q.set('search', params.search);
  if (params.page) q.set('page', params.page);
  const queryStr = q.toString() ? `?${q.toString()}` : '';
  return apiFetch(`/admin/users${queryStr}`);
}

export async function setAdminUserStatus(id, isActive) {
  return apiFetch(`/admin/users/${id}/status`, {
    method: 'PATCH',
    body: { is_active: isActive },
  });
}

export async function setAdminUserRole(id, role) {
  return apiFetch(`/admin/users/${id}/role`, {
    method: 'PATCH',
    body: { role },
  });
}

// Academic management (departments, programmes, academic years, categories). Nothing here deletes: records are deactivated or closed.
const send = (path, method, body) => apiFetch(path, { method, body });
export const getAdminCategories = () => apiFetch('/admin/categories');
export const createAdminCategory = (data) => send('/admin/categories', 'POST', data);
export const updateAdminCategory = (id, data) => send(`/admin/categories/${id}`, 'PUT', data);
export const toggleAdminCategory = (id, isActive) => send(`/admin/categories/${id}/status`, 'PATCH', { is_active: isActive });

export const getAdminSessions = () => apiFetch('/admin/sessions');
export const createAdminSession = (data) => send('/admin/sessions', 'POST', data);
export const updateAdminSession = (id, data) => send(`/admin/sessions/${id}`, 'PUT', data);
export const setAdminSessionCurrent = (id) => send(`/admin/sessions/${id}/set-current`, 'PATCH');
export const archiveAdminSession = (id, archived) => send(`/admin/sessions/${id}/archive`, 'PATCH', { archived });

export const getAdminDepartments = () => apiFetch('/admin/departments');
export const createAdminDepartment = (data) => send('/admin/departments', 'POST', data);
export const updateAdminDepartment = (id, data) => send(`/admin/departments/${id}`, 'PUT', data);
export const setAdminDepartmentStatus = (id, isActive) => send(`/admin/departments/${id}/status`, 'PATCH', { is_active: isActive });

export const getAdminProgrammes = () => apiFetch('/admin/programmes');
export const createAdminProgramme = (data) => send('/admin/programmes', 'POST', data);
export const updateAdminProgramme = (id, data) => send(`/admin/programmes/${id}`, 'PUT', data);
export const setAdminProgrammeStatus = (id, isActive) => send(`/admin/programmes/${id}/status`, 'PATCH', { is_active: isActive });

export const assignAcademic = (userId, data) => send(`/admin/users/${userId}/academic`, 'PATCH', data);

// Administrator audit log (read-only). Empty values and "all" are not sent.
export const getAdminAudit = (params = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== 'all' && v !== undefined && v !== null) q.set(k, String(v));
  return apiFetch(`/admin/audit${q.toString() ? `?${q}` : ''}`);
};

// -------------------------------------------------------------
// ANALYTICS & EXPORTS
// -------------------------------------------------------------
// Filters shared by the dashboard and both exports, so what is downloaded always matches what is on screen.
export const ANALYTICS_FILTER_KEYS = ['department', 'programme', 'category', 'academic_session', 'semester', 'status', 'date_from', 'date_to'];
export function analyticsQuery(params = {}, extra = {}) {
  const q = new URLSearchParams();
  ANALYTICS_FILTER_KEYS.forEach((k) => { const v = params[k]; if (v !== undefined && v !== null && v !== '' && v !== 'all') q.set(k, v); });
  Object.entries(extra).forEach(([k, v]) => q.set(k, v));
  return q.toString() ? `?${q.toString()}` : '';
}
export const getAnalytics = (params = {}) => apiFetch(`/analytics${analyticsQuery(params)}`);
export const getAnalyticsOptions = () => apiFetch('/analytics/options');

async function downloadReport(kind, params, report) {
  const token = getToken();
  if (!token) throw new Error('Authentication required to export data');
  const res = await fetch(`${API_URL}/analytics/export/${kind}${analyticsQuery(params, report ? { report } : {})}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to download the ${kind.toUpperCase()} report`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || `SARP_report.${kind}`;
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return name;
}
/** report: 'activities' | 'department' | 'semester' */
export const downloadAnalyticsCsv = (params = {}, report = 'activities') => downloadReport('csv', params, report);
/** report: 'institutional' | 'department' | 'semester' */
export const downloadAnalyticsPdf = (params = {}, report = 'institutional') => downloadReport('pdf', params, report);

/**
 * Safely opens a protected proof document in a new browser tab.
 */
// Downloads a protected proof (with the user's token) and returns a temporary local URL for it. Caller revokes it.
export async function fetchProofBlob(activityId, version) {
  const token = getToken();
  if (!token) throw new Error('Authentication required to view evidence');
  const res = await fetch(`${API_URL}/activities/${activityId}/proof${version ? `?version=${version}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `Failed to open proof document (${res.status})`);
  }
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), type: blob.type };
}

export async function viewProofDocument(activityId, version) {
  const { url } = await fetchProofBlob(activityId, version);
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win) {
    URL.revokeObjectURL(url);
    throw new Error('Pop-up window blocked. Please allow pop-ups for this site to view documents.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return true;
}

/**
 * Downloads the verified portfolio PDF for a student.
 */
export async function downloadPortfolioPdf(studentId, studentName = 'Student') {
  const token = getToken();
  if (!token) throw new Error('Authentication required to download portfolio');

  const res = await fetch(`${API_URL}/portfolio/${studentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `Failed to download portfolio PDF (${res.status})`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const safeName = studentName.replace(/[^a-z0-9_-]/gi, '_');
  link.download = `${safeName}_SARP_Portfolio.pdf`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------------------
// Onboarding: public activation / reset flows (no session required)
// ---------------------------------------------------------------------------
export const getAuthConfig = () => apiFetch('/auth/config');
export const getTokenInfo = (token) => apiFetch('/auth/token-info', { method: 'POST', body: { token } });
export const activateAccount = (token, password) => apiFetch('/auth/activate', { method: 'POST', body: { token, password } });
export const resetPassword = (token, password) => apiFetch('/auth/reset-password', { method: 'POST', body: { token, password } });
export const requestActivation = (data) => apiFetch('/auth/request-activation', { method: 'POST', body: data });
export const forgotPassword = (email) => apiFetch('/auth/forgot-password', { method: 'POST', body: { email } });

// Same rules as the server (utils/validation.js passwordProblem); the server is authoritative.
export function passwordProblem(password) {
  if (password.length < 8) return 'Password must be at least 8 characters long';
  if (password.length > 72) return 'Password must be 72 characters or fewer';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Password must contain at least one letter and one number';
  return null;
}

// ---------------------------------------------------------------------------
// Admin: student bulk import and activation links
// ---------------------------------------------------------------------------
// path is 'students' or 'faculty'; the backend runs the same preview -> confirm pipeline for both.
export const previewImport = (path, file) => {
  const form = new FormData();
  form.append('file', file);
  return apiFetch(`/admin/${path}/import/preview`, { method: 'POST', body: form, isForm: true });
};
export const confirmImport = (path, batchId) => apiFetch(`/admin/${path}/import/${batchId}/confirm`, { method: 'POST', body: {} });
export const cancelImport = (path, batchId) => apiFetch(`/admin/${path}/import/${batchId}/cancel`, { method: 'POST', body: {} });
export const getImportHistory = (kind) => apiFetch(`/admin/imports${kind ? `?kind=${kind}` : ''}`);
export const getImportDetail = (batchId) => apiFetch(`/admin/imports/${batchId}`);
export const createUserLink = (userId, delivery) =>
  apiFetch(`/admin/users/${userId}/activation-link`, { method: 'POST', body: delivery ? { delivery } : {} });

// The returned CSV contains live one-time links. It is generated per request and never stored.
export async function downloadActivationLinks(batchId) {
  const res = await apiFetch(`/admin/imports/${batchId}/activation-links`, { method: 'POST', body: {}, raw: true });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Could not generate activation links');
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `activation-links-import-${batchId}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Admin: faculty provisioning, verification scope, administrators (Super Admin)
// ---------------------------------------------------------------------------
export const getFacultyList = (params = {}) => {
  const q = new URLSearchParams();
  for (const k of ['search', 'department', 'account_status', 'page', 'limit']) if (params[k]) q.set(k, params[k]);
  return apiFetch(`/admin/faculty${q.toString() ? `?${q}` : ''}`);
};
export const createFaculty = (data) => apiFetch('/admin/faculty', { method: 'POST', body: data });
export const updateFaculty = (id, data) => apiFetch(`/admin/faculty/${id}`, { method: 'PUT', body: data });
export const setFacultyScope = (id, scope) => apiFetch(`/admin/faculty/${id}/scope`, { method: 'PUT', body: scope });
export const getAdministrators = () => apiFetch('/admin/administrators');
export const createAdministrator = (data) => apiFetch('/admin/administrators', { method: 'POST', body: data });
export const setSuperAdmin = (id, isSuper) => apiFetch(`/admin/administrators/${id}/super`, { method: 'PATCH', body: { super: isSuper } });


// -------------------------------------------------------------
// PROFILE PHOTO (own photo only; the server has no way to address another user's)
// -------------------------------------------------------------
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function uploadProfilePhoto(file) {
  const form = new FormData();
  form.append('photo', file);
  return apiFetch('/auth/profile/photo', { method: 'PUT', body: form, isForm: true });
}

export async function removeProfilePhoto() {
  return apiFetch('/auth/profile/photo', { method: 'DELETE' });
}

/** Loads the signed-in user's photo as an object URL (the image endpoint needs the Authorization header). */
export async function fetchOwnPhotoUrl() {
  const res = await apiFetch('/auth/profile/photo', { raw: true });
  if (!res.ok) throw new Error('No photo');
  return URL.createObjectURL(await res.blob());
}

// -------------------------------------------------------------
// APPEARANCE (saved on the account so it follows the user across devices)
// -------------------------------------------------------------
export async function updateThemePreference(theme) {
  return apiFetch('/auth/preferences', { method: 'PUT', body: { theme } });
}

// -------------------------------------------------------------
// SUPPORT TICKETS
// -------------------------------------------------------------
const query = (params = {}) => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '' && v !== 'all') qs.set(k, v); });
  const s = qs.toString();
  return s ? `?${s}` : '';
};
export const createSupportTicket = (data) => apiFetch('/support/tickets', { method: 'POST', body: data });
export const getMySupportTickets = (params) => apiFetch(`/support/tickets${query(params)}`);
export const getAdminSupportTickets = (params) => apiFetch(`/admin/support/tickets${query(params)}`);
export const updateAdminSupportTicket = (ref, data) => apiFetch(`/admin/support/tickets/${ref}`, { method: 'PATCH', body: data });
