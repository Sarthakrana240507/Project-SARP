import { useTheme } from '@/lib/theme';

const OPTIONS = [
  {
    id: 'light', label: 'Light',
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />,
  },
  {
    id: 'dark', label: 'Dark',
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />,
  },
  {
    id: 'system', label: 'System',
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />,
  },
];

/**
 * Light / Dark / System chooser. `compact` hides the labels (used on the sign-in pages and in the menu).
 * Applies at once, remembers the choice on this device and, when signed in, on the account.
 */
export default function ThemeSelector({ compact = false, className = '', testId = 'theme-selector' }) {
  const { preference, setPreference } = useTheme();
  return (
    <div role="radiogroup" aria-label="Appearance" data-testid={testId} className={`inline-flex rounded-xl border border-line bg-surface-sub p-0.5 ${className}`}>
      {OPTIONS.map((o) => {
        const on = preference === o.id;
        return (
          <button
            key={o.id} type="button" role="radio" aria-checked={on} aria-label={`${o.label} theme`} title={`${o.label} theme`}
            data-testid={`${testId}-${o.id}`} data-active={on}
            onClick={() => setPreference(o.id)}
            className={`flex items-center justify-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${on ? 'bg-surface text-ink-strong shadow-sm' : 'text-ink-secondary hover:text-ink-strong'}`}
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">{o.icon}</svg>
            {!compact && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
