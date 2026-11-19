// Small helpers shared by the notification bell and the notifications page.

// Only in-app paths are followed. Anything else (external address, javascript:, protocol-relative) is ignored.
export function safeInAppLink(link) {
  if (typeof link !== 'string') return null;
  if (!link.startsWith('/') || link.startsWith('//') || link.includes('://') || link.includes('\\')) return null;
  return link;
}

export const TYPE_STYLE = {
  success: { dot: 'bg-accent', chip: 'bg-accent-soft text-accent-text', label: 'Success' },
  warning: { dot: 'bg-amber-500', chip: 'bg-warn-soft text-warn-text', label: 'Action needed' },
  error: { dot: 'bg-rose-500', chip: 'bg-danger-soft text-danger-text', label: 'Rejected' },
  info: { dot: 'bg-brand', chip: 'bg-brand-soft text-brand-text', label: 'Update' },
};

export function formatWhen(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString()} · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
