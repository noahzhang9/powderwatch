import { useEffect, useState } from 'react';

/** Minimal hash router: #/resort/crystal/storm → ['resort', 'crystal', 'storm']. */
export function useRoute(): string[] {
  const parse = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [parts, setParts] = useState(parse);
  useEffect(() => {
    const on = () => setParts(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

export const href = (...parts: string[]) => `#/${parts.join('/')}`;
