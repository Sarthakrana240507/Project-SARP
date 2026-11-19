/** @type {import('tailwindcss').Config} */
const plugin = require('tailwindcss/plugin');
const defaultColors = require('tailwindcss/colors');

// ---------------------------------------------------------------------------------------------
// Theming: every colour is a CSS variable ("R G B" so opacity modifiers like bg-surface/80 work).
//  - Semantic tokens (surface, ink, brand ...) are defined by hand in styles/theme.css.
//  - The standard Tailwind palettes the app already uses for badges (rose, emerald, amber, ...)
//    are generated below: light mode = Tailwind's own values, dark mode = the same palette mirrored
//    (50 <-> 950, 100 <-> 900, ...), so bg-rose-50 + text-rose-800 stays a readable pair in both themes.
// ---------------------------------------------------------------------------------------------
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const DARK_SHADE = { 50: '950', 100: '900', 200: '800', 300: '700', 400: '600', 500: '400', 600: '400', 700: '300', 800: '200', 900: '100', 950: '50' };
const PALETTES = ['slate', 'rose', 'emerald', 'amber', 'orange', 'blue'];
// "slate" is the app's neutral grey: warm and slightly green instead of Tailwind's blue-grey.
const CUSTOM = {
  slate: { 50: '#F7F9F8', 100: '#EEF2F0', 200: '#E3E9E6', 300: '#CBD5D1', 400: '#9AA7A2', 500: '#6F7D78', 600: '#55635E', 700: '#3F4D49', 800: '#2B3834', 900: '#1D2824', 950: '#111A17' },
};

const triplet = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
};
const withVar = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const token = (name) => withVar(name);

const paletteColors = {};
const paletteLight = {};
const paletteDark = {};
for (const p of PALETTES) {
  paletteColors[p] = {};
  for (const s of SHADES) {
    paletteColors[p][s] = withVar(`${p}-${s}`);
    const scale = CUSTOM[p] || defaultColors[p];
    paletteLight[`--${p}-${s}`] = triplet(scale[s]);
    paletteDark[`--${p}-${s}`] = triplet(scale[DARK_SHADE[s]]);
  }
}

module.exports = {
  content: ['./pages/**/*.{js,jsx}', './components/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ...paletteColors,
        canvas: token('canvas'),
        surface: { DEFAULT: token('surface'), alt: token('surface-alt'), sub: token('surface-sub') },
        line: { DEFAULT: token('line'), soft: token('line-soft'), strong: token('line-strong') },
        ink: { DEFAULT: token('ink'), strong: token('ink-strong'), body: token('ink-body'), secondary: token('ink-secondary'), muted: token('ink-muted') },
        navy: { DEFAULT: token('navy'), hover: token('navy-hover'), dark: token('navy-dark') },
        hero: { from: token('hero-from'), via: token('hero-via') },
        brand: { DEFAULT: token('brand'), text: token('brand-text'), strong: token('brand-strong'), soft: token('brand-soft'), subtle: token('brand-subtle'), line: token('brand-line') },
        accent: { DEFAULT: token('accent'), text: token('accent-text'), strong: token('accent-strong'), soft: token('accent-soft'), line: token('accent-line') },
        danger: { soft: token('danger-soft'), text: token('danger-text'), line: token('danger-line') },
        success: { soft: token('success-soft'), text: token('success-text'), line: token('success-line') },
        warn: { soft: token('warn-soft'), text: token('warn-text'), line: token('warn-line') },
        flame: { soft: token('flame-soft'), text: token('flame-text'), line: token('flame-line') },
        violet: { soft: token('violet-soft'), text: token('violet-text'), line: token('violet-line') },
        solid: { danger: token('solid-danger'), 'danger-hover': token('solid-danger-hover'), success: token('solid-success'), 'success-hover': token('solid-success-hover'), flame: token('solid-flame'), 'flame-hover': token('solid-flame-hover') },
        pink: { soft: token('pink-soft'), text: token('pink-text'), line: token('pink-line') },
      },
      boxShadow: {
        subtle: '0 1px 3px rgb(var(--shadow) / 0.05), 0 1px 2px rgb(var(--shadow) / 0.03)',
        card: '0 2px 8px rgb(var(--shadow) / 0.04), 0 1px 3px rgb(var(--shadow) / 0.02)',
        cardHover: '0 8px 24px rgb(var(--shadow) / 0.08), 0 2px 6px rgb(var(--shadow) / 0.03)',
        modal: '0 20px 40px -15px rgb(var(--shadow) / 0.25)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: { 'fade-in': 'fadeIn 0.2s ease-out forwards' },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': paletteLight,
        ':root[data-theme="dark"]': paletteDark,
      });
    }),
  ],
};
