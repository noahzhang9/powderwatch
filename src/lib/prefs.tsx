/** User preferences (units, theme) persisted in localStorage, plus formatters. */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { storageGet, storageSet } from './storage';

export type Units = 'metric' | 'imperial';
export type ThemePref = 'system' | 'light' | 'dark';

interface Prefs {
  units: Units;
  setUnits: (u: Units) => void;
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  /** Resolved theme actually shown. */
  dark: boolean;
}

const Ctx = createContext<Prefs | null>(null);

function stored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  const v = storageGet(key) as T | null;
  return v && allowed.includes(v) ? v : fallback;
}

function applyTheme(t: ThemePref) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [units, setUnitsState] = useState<Units>(() => stored<Units>('pw-units', 'imperial', ['metric', 'imperial']));
  const [theme, setThemeState] = useState<ThemePref>(() => {
    const t = stored<ThemePref>('pw-theme', 'system', ['system', 'light', 'dark']);
    applyTheme(t);
    return t;
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const value = useMemo<Prefs>(
    () => ({
      units,
      setUnits: (u) => {
        storageSet('pw-units', u);
        setUnitsState(u);
      },
      theme,
      setTheme: (t) => {
        storageSet('pw-theme', t);
        applyTheme(t); // before re-render, so charts read the new palette
        setThemeState(t);
      },
      dark: theme === 'dark' || (theme === 'system' && systemDark),
    }),
    [units, theme, systemDark],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrefs(): Prefs {
  const p = useContext(Ctx);
  if (!p) throw new Error('PrefsProvider missing');
  return p;
}

export interface Fmt {
  units: Units;
  /** Snow depth/amount from cm. */
  snow: (cm: number | null | undefined, digits?: number) => string;
  snowVal: (cm: number | null | undefined) => number | null;
  snowUnit: string;
  water: (mm: number | null | undefined) => string;
  waterVal: (mm: number | null | undefined) => number | null;
  waterUnit: string;
  elev: (m: number | null | undefined) => string;
  elevVal: (m: number | null | undefined) => number | null;
  elevUnit: string;
  temp: (c: number | null | undefined) => string;
  tempVal: (c: number | null | undefined) => number | null;
  tempUnit: string;
  wind: (kmh: number | null | undefined) => string;
  /** Compact ranges with one unit: "12–30 cm", "1,200–1,600 m". */
  snowRange: (a: number | null | undefined, b: number | null | undefined) => string;
  elevRange: (a: number | null | undefined, b: number | null | undefined) => string;
  windVal: (kmh: number | null | undefined) => number | null;
  windUnit: string;
}

const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function makeFmt(units: Units): Fmt {
  const imp = units === 'imperial';
  const snowVal = (cm: number | null | undefined) => (fin(cm) ? (imp ? cm / 2.54 : cm) : null);
  const waterVal = (mm: number | null | undefined) => (fin(mm) ? (imp ? mm / 25.4 : mm) : null);
  const elevVal = (m: number | null | undefined) => (fin(m) ? (imp ? m * 3.28084 : m) : null);
  const tempVal = (c: number | null | undefined) => (fin(c) ? (imp ? c * 1.8 + 32 : c) : null);
  const windVal = (k: number | null | undefined) => (fin(k) ? (imp ? k / 1.609344 : k) : null);
  const num = (v: number | null, digits: number) =>
    v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  return {
    units,
    snowVal, waterVal, elevVal, tempVal, windVal,
    snowUnit: imp ? 'in' : 'cm',
    waterUnit: imp ? 'in' : 'mm',
    elevUnit: imp ? 'ft' : 'm',
    tempUnit: imp ? '°F' : '°C',
    windUnit: imp ? 'mph' : 'km/h',
    snow: (cm, digits) => {
      const v = snowVal(cm);
      const d = digits ?? (imp ? (v != null && v < 10 ? 1 : 0) : 0);
      return v == null ? '—' : `${num(v, d)} ${imp ? 'in' : 'cm'}`;
    },
    water: (mm) => (waterVal(mm) == null ? '—' : `${num(waterVal(mm), imp ? 2 : 1)} ${imp ? 'in' : 'mm'}`),
    elev: (m) => (elevVal(m) == null ? '—' : `${num(Math.round(elevVal(m)! / 10) * 10, 0)} ${imp ? 'ft' : 'm'}`),
    temp: (c) => (tempVal(c) == null ? '—' : `${num(tempVal(c), 0)}°`),
    wind: (k) => (windVal(k) == null ? '—' : `${num(windVal(k), 0)} ${imp ? 'mph' : 'km/h'}`),
    snowRange: (a, b) => {
      const x = snowVal(a);
      const y = snowVal(b);
      if (x == null || y == null) return '—';
      const d = imp && y < 10 ? 1 : 0;
      return `${num(x, d)}–${num(y, d)} ${imp ? 'in' : 'cm'}`;
    },
    elevRange: (a, b) => {
      const x = elevVal(a);
      const y = elevVal(b);
      if (x == null || y == null) return '—';
      return `${num(Math.round(x / 10) * 10, 0)}–${num(Math.round(y / 10) * 10, 0)} ${imp ? 'ft' : 'm'}`;
    },
  };
}

export function useFmt(): Fmt {
  const { units } = usePrefs();
  return useMemo(() => makeFmt(units), [units]);
}
