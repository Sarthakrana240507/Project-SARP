import { useEffect, useState } from 'react';
import { fetchOwnPhotoUrl } from '@/lib/api';

// The photo is requested once per version and shared by every Avatar on the page (navbar + profile).
const cache = { key: null, url: null, pending: null };

function loadPhoto(key) {
  if (cache.key === key && cache.url) return Promise.resolve(cache.url);
  if (cache.key === key && cache.pending) return cache.pending;
  if (cache.url) URL.revokeObjectURL(cache.url);
  cache.key = key; cache.url = null;
  cache.pending = fetchOwnPhotoUrl()
    .then((url) => { if (cache.key === key) cache.url = url; return url; })
    .finally(() => { cache.pending = null; });
  return cache.pending;
}

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = Array.from(parts[0])[0];
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] : '';
  return (first + last).toUpperCase();
}

/** Round avatar for the signed-in user: photo when there is one, otherwise initials, otherwise a default silhouette. */
export default function Avatar({ user, size = 36, className = '', testId = 'avatar' }) {
  const [src, setSrc] = useState(null);
  const key = user?.has_photo ? `${user.id}:${user.photo_version}` : null;

  useEffect(() => {
    let live = true;
    if (!key) { setSrc(null); return undefined; }
    loadPhoto(key).then((url) => { if (live) setSrc(url); }).catch(() => { if (live) setSrc(null); });
    return () => { live = false; };
  }, [key]);

  const initials = initialsOf(user?.name);
  const box = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) };
  return (
    <span
      data-testid={testId} data-kind={src ? 'photo' : initials ? 'initials' : 'default'}
      style={box} aria-label={user?.name ? `${user.name}'s profile picture` : 'Default profile picture'} role="img"
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-navy font-bold text-white ${className}`}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : initials ? (
        initials
      ) : (
        <svg viewBox="0 0 24 24" className="h-3/5 w-3/5" fill="currentColor" aria-hidden="true">
          <path d="M12 12a4.5 4.5 0 100-9 4.5 4.5 0 000 9zm0 2c-4.1 0-7.5 2.2-7.5 5v1h15v-1c0-2.8-3.4-5-7.5-5z" />
        </svg>
      )}
    </span>
  );
}
