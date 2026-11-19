import { useCallback, useEffect, useState } from 'react';

function parse() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(query) };
}

/** Minimal hash router: #/resort/crystal/storm?band=mid → parts ['resort','crystal','storm'], query band=mid. */
export function useRoute(): { parts: string[]; query: URLSearchParams } {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const href = (...parts: string[]) => `#/${parts.join('/')}`;

/** A view setting persisted in the URL hash query (shareable, survives tab switches). */
export function useHashParam<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const { query } = useRoute();
  const raw = query.get(key) as T | null;
  const value = raw && allowed.includes(raw) ? raw : fallback;
  const set = useCallback(
    (v: T) => {
      const { parts, query: q } = parse();
      if (v === fallback) q.delete(key);
      else q.set(key, v);
      const qs = q.toString();
      window.history.replaceState(null, '', `#/${parts.join('/')}${qs ? `?${qs}` : ''}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    },
    [key, fallback],
  );
  return [value, set];
}
