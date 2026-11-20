/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in snapshot-only local builds (`npm run build:local`, `npm run preview:local`); unset in production. */
  readonly VITE_SNAPSHOT_ONLY?: string;
}
