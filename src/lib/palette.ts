/** Read chart colours from CSS custom properties so charts follow the selected theme. */
export interface ChartPalette {
  slots: string[];
  ink1: string;
  ink2: string;
  ink3: string;
  grid: string;
  axis: string;
  surface: string;
  surface2: string;
  seq: { s100: string; s200: string; s300: string; s450: string; s600: string; s700: string };
  critical: string;
  warning: string;
  proj: { line: string; outer: string; inner: string };
  /** Ordinal snow-amount ramp, least → most. */
  snowRamp: string[];
  rain: string;
  lastSeason: string;
  /** Sequential ramp ordered from least to most emphasis on the current surface. */
  emphasisRamp: string[];
  dark: boolean;
}

export function readPalette(): ChartPalette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const dark = cs.colorScheme.includes('dark');
  return {
    slots: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--s${i}`)),
    ink1: v('--ink-1'), ink2: v('--ink-2'), ink3: v('--ink-3'),
    grid: v('--grid'), axis: v('--axis'), surface: v('--surface-1'), surface2: v('--surface-2'),
    seq: { s100: v('--seq-100'), s200: v('--seq-200'), s300: v('--seq-300'), s450: v('--seq-450'), s600: v('--seq-600'), s700: v('--seq-700') },
    critical: v('--critical'), warning: v('--warning'),
    proj: { line: v('--proj-line'), outer: v('--proj-band-outer'), inner: v('--proj-band-inner') },
    snowRamp: [1, 2, 3, 4, 5, 6].map((i) => v(`--snow-${i}`)),
    rain: v('--rain'),
    lastSeason: v('--last-season'),
    emphasisRamp: dark
      ? [v('--seq-700'), v('--seq-600'), v('--seq-450'), v('--seq-300'), v('--seq-200'), v('--seq-100')]
      : [v('--seq-100'), v('--seq-200'), v('--seq-300'), v('--seq-450'), v('--seq-600'), v('--seq-700')],
    dark,
  };
}

export const slotColor = (p: ChartPalette, slot: number) => p.slots[(slot - 1) % 8];

/** Hex → rgba with alpha, for translucent bands. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Upper bounds (cm) of the snow-amount classes; the last class is open-ended. */
export const SNOW_CLASSES_CM = [2.5, 5, 10, 20, 30];

/** Ramp step (0–5) for a daily snow amount in cm. */
export function snowClass(cm: number | null | undefined): number {
  if (cm == null || !(cm > 0)) return 0;
  const i = SNOW_CLASSES_CM.findIndex((b) => cm < b);
  return i < 0 ? SNOW_CLASSES_CM.length : i;
}
