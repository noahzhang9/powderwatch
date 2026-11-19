/** Small numeric helpers shared by blending, ensembles and climatology. */

export type Num = number | null | undefined;
export type Series = (number | null)[];

export const isNum = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v);

export function sum(values: Num[]): number {
  let s = 0;
  for (const v of values) if (isNum(v)) s += v;
  return s;
}

/** Weighted mean of the finite values; null when no weight remains. */
export function weightedMean(values: Num[], weights: number[]): number | null {
  let s = 0;
  let w = 0;
  values.forEach((v, i) => {
    if (isNum(v) && weights[i] > 0) {
      s += v * weights[i];
      w += weights[i];
    }
  });
  return w > 0 ? s / w : null;
}

/**
 * Weighted quantile (q in 0..1) using the midpoint-of-weight (Hazen)
 * convention: each value sits at the centre of its share of the total weight,
 * values are linearly interpolated between centres and clamped outside them.
 */
export function weightedQuantile(values: Num[], weights: number[], q: number): number | null {
  const pts = values
    .map((v, i) => ({ v, w: weights[i] }))
    .filter((p): p is { v: number; w: number } => isNum(p.v) && p.w > 0)
    .sort((a, b) => a.v - b.v);
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0].v;
  const total = pts.reduce((s, p) => s + p.w, 0);
  // Position of each point = cumulative weight at its centre, normalised to 0..1.
  let acc = 0;
  const pos = pts.map((p) => {
    const c = (acc + p.w / 2) / total;
    acc += p.w;
    return c;
  });
  const target = Math.min(1, Math.max(0, q));
  if (target <= pos[0]) return pts[0].v;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (target <= pos[i + 1]) {
      const f = (target - pos[i]) / (pos[i + 1] - pos[i] || 1);
      return pts[i].v + f * (pts[i + 1].v - pts[i].v);
    }
  }
  return pts[pts.length - 1].v;
}

export function quantile(values: Num[], q: number): number | null {
  return weightedQuantile(values, values.map(() => 1), q);
}

/** Weighted probability that value ≥ threshold. */
export function exceedance(values: Num[], weights: number[], threshold: number): number | null {
  let hit = 0;
  let w = 0;
  values.forEach((v, i) => {
    if (isNum(v) && weights[i] > 0) {
      w += weights[i];
      if (v >= threshold) hit += weights[i];
    }
  });
  return w > 0 ? hit / w : null;
}

/** Running total that stays null after the series ends (null = no data). */
export function cumulative(values: Num[]): (number | null)[] {
  let acc = 0;
  let lastValid = -1;
  values.forEach((v, i) => {
    if (isNum(v)) lastValid = i;
  });
  return values.map((v, i) => {
    if (i > lastValid) return null;
    if (isNum(v)) acc += v;
    return acc;
  });
}

/**
 * Family-balanced weights: each family present gets equal total weight, split
 * evenly among its members that have a value. Prevents a 51-member ensemble
 * (or two variants of one centre's model) from dominating a blend.
 */
export function familyWeights(families: string[], present: boolean[]): number[] {
  const counts = new Map<string, number>();
  families.forEach((f, i) => {
    if (present[i]) counts.set(f, (counts.get(f) ?? 0) + 1);
  });
  const nFam = counts.size;
  return families.map((f, i) => (present[i] && nFam > 0 ? 1 / (nFam * (counts.get(f) ?? 1)) : 0));
}

export const round = (v: number | null | undefined, digits = 0): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits;
