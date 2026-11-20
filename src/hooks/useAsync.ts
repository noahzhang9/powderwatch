import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** Re-run the loader (e.g. after a failed request). */
  retry: () => void;
}

/** A loader's last result, and the deps it was loaded for (null before the first). */
export interface StoredResult<T> {
  deps: DependencyList | null;
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

/** Whether two deps lists hold the same values, compared as React compares deps. */
export function sameDeps(a: DependencyList | null, b: DependencyList): boolean {
  return a != null && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

/**
 * What a component sees. A result loaded for other deps (the previous band, station or resort)
 * is never returned: until the new one arrives the component sees "loading", so a view can't
 * show one band's numbers under another's label, or combine one resort's config with another's data.
 */
export function visibleResult<T>(s: StoredResult<T>, deps: DependencyList, enabled: boolean): Omit<AsyncState<T>, 'retry'> {
  if (sameDeps(s.deps, deps)) return { data: s.data, error: s.error, loading: s.loading };
  return { data: undefined, error: undefined, loading: enabled };
}

/**
 * Runs an async loader when deps change. A re-run for the same deps (retry) keeps the
 * previous data while it reloads, so there is no skeleton flash.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, enabled = true): AsyncState<T> {
  const [state, setState] = useState<StoredResult<T>>({ deps: null, data: undefined, error: undefined, loading: false });
  const seq = useRef(0);
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const id = ++seq.current;
    const forDeps = [...deps];
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn().then(
      (data) => id === seq.current && setState({ deps: forDeps, data, error: undefined, loading: false }),
      (error: Error) =>
        id === seq.current &&
        setState((s) => ({ deps: forDeps, data: sameDeps(s.deps, forDeps) ? s.data : undefined, error, loading: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);
  return { ...visibleResult(state, deps, enabled), retry };
}
