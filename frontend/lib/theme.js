// Appearance: light, dark, or follow the operating system ("system").
//   - The choice is kept in localStorage ('sarp-theme') so signed-out pages (login, activate ...) honour it too.
//   - When signed in it is also saved on the account, so it follows the user to other devices.
//   - <html data-theme="light|dark"> is set before first paint by the inline script in pages/_document.js;
//     the functions here keep it in step afterwards. All colours come from CSS variables (styles/theme.css).
import { useCallback, useEffect, useState } from 'react';

export const STORAGE_KEY = 'sarp-theme';
export const PREFERENCES = ['light', 'dark', 'system'];
export const THEME_EVENT = 'sarp:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const isPreference = (v) => PREFERENCES.includes(v);
const safeGet = () => { try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; } };
const safeSet = (v) => { try { window.localStorage.setItem(STORAGE_KEY, v); } catch { /* private mode: the choice then lasts for this page only */ } };

/** The saved choice, or null if this browser has never made one. */
export function getStoredPreference() {
  if (typeof window === 'undefined') return null;
  const v = safeGet();
  return isPreference(v) ? v : null;
}

export function getPreference() {
  return getStoredPreference() || 'system';
}

export function resolveTheme(preference) {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** Puts a preference on the page (no saving). */
export function applyTheme(preference = getPreference()) {
  if (typeof document === 'undefined') return 'light';
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-pref', preference);
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#111817' : '#F4F6F5');
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { preference, resolved } }));
  return resolved;
}

function rememberOnStoredUser(preference) {
  try {
    const user = JSON.parse(window.localStorage.getItem('user') || 'null');
    if (user) window.localStorage.setItem('user', JSON.stringify({ ...user, theme_preference: preference }));
  } catch { /* ignore */ }
}

/** The user picked a theme: apply it, remember it on this device and (when signed in) on the account. */
export async function setThemePreference(preference) {
  if (!isPreference(preference)) return;
  safeSet(preference);
  applyTheme(preference);
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  if (!token) return;
  rememberOnStoredUser(preference);
  try {
    const { updateThemePreference } = await import('./api');
    await updateThemePreference(preference);
  } catch { /* saved on this device; the account copy is retried on the next change */ }
}

/**
 * Called right after signing in. The account's saved choice wins (it is what the user picked on another device);
 * if the account has none yet but this browser does, the browser's choice is saved to the account.
 */
export async function adoptAccountPreference(user) {
  if (typeof window === 'undefined' || !user) return;
  const remote = user.theme_preference;
  if (isPreference(remote)) {
    if (remote !== getStoredPreference()) { safeSet(remote); applyTheme(remote); }
    return;
  }
  const local = getStoredPreference();
  if (local) {
    rememberOnStoredUser(local);
    try { const { updateThemePreference } = await import('./api'); await updateThemePreference(local); } catch { /* ignore */ }
  }
}

let started = false;
/** Installs the listeners that keep the page in step (called once from _app). */
export function initTheme() {
  if (typeof window === 'undefined' || started) return undefined;
  started = true;
  applyTheme();
  const media = window.matchMedia ? window.matchMedia(DARK_QUERY) : null;
  // System mode stays live: if the OS flips between light and dark, so does the app.
  const onSystemChange = () => { if (getPreference() === 'system') applyTheme('system'); };
  if (media?.addEventListener) media.addEventListener('change', onSystemChange); else if (media?.addListener) media.addListener(onSystemChange);
  // Another tab changed the choice.
  const onStorage = (e) => { if (e.key === STORAGE_KEY) applyTheme(); };
  window.addEventListener('storage', onStorage);
  // Printed pages (portfolio PDF view) are always light.
  let before = null;
  window.addEventListener('beforeprint', () => { before = document.documentElement.getAttribute('data-theme'); document.documentElement.setAttribute('data-theme', 'light'); });
  window.addEventListener('afterprint', () => { if (before) document.documentElement.setAttribute('data-theme', before); before = null; });
  return undefined;
}

/** { preference, resolved, setPreference } for components. Re-renders when the theme changes. */
export function useTheme() {
  const [state, setState] = useState({ preference: 'system', resolved: 'light' });
  useEffect(() => {
    const read = () => setState({ preference: getPreference(), resolved: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light' });
    read();
    window.addEventListener(THEME_EVENT, read);
    return () => window.removeEventListener(THEME_EVENT, read);
  }, []);
  const setPreference = useCallback((p) => setThemePreference(p), []);
  return { ...state, setPreference };
}

// ---- charts -------------------------------------------------------------------------------------
const SERIES = {
  light: ['#3A6560', '#657A9C', '#4F9A8E', '#7A8DAE', '#7B6FA8', '#D08A2E', '#C2566B'],
  dark: ['#7DBCB4', '#96AACD', '#5FB3A6', '#B3C0DB', '#A99BD6', '#E3A94F', '#E58A9B'],
};
const cssColor = (name) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v})` : undefined;
};

/** Colours for Recharts that follow the theme (axis, grid, tooltip, series). */
export function useChartTheme() {
  const { resolved } = useTheme();
  const [colors, setColors] = useState(() => ({ grid: '#E3E9E6', axis: '#5A6770', tooltipBg: '#27333A', tooltipText: '#FFFFFF', series: SERIES.light }));
  useEffect(() => {
    setColors({
      grid: cssColor('--chart-grid'), axis: cssColor('--chart-axis'),
      tooltipBg: cssColor('--chart-tooltip-bg'), tooltipText: cssColor('--chart-tooltip-text'),
      series: SERIES[resolved],
    });
  }, [resolved]);
  return { ...colors, resolved };
}
