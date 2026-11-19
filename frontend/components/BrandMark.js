// The SARP mark: a rounded teal square with an "S". Used by the login screens and the sidebar.
export default function BrandMark({ size = 40, withText = true, subtitle = true }) {
  return (
    <span className="flex items-center gap-3">
      <span style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-xl bg-navy text-sm font-bold text-white shadow-subtle" aria-hidden="true">S</span>
      {withText && (
        <span className="leading-tight">
          <span className="block text-base font-bold text-ink-strong">SARP</span>
          {subtitle && <span className="block text-[11px] text-ink-secondary">Student Activity Records Platform</span>}
        </span>
      )}
    </span>
  );
}
