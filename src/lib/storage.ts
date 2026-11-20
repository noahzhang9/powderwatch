/**
 * localStorage that never throws. Where the browser blocks storage (SecurityError) or the quota
 * is full, reads find nothing and writes are dropped: preferences, trips and "since your last
 * visit" just aren't remembered, and the control that wrote them still works.
 */
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered */
  }
}

export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing stored */
  }
}
