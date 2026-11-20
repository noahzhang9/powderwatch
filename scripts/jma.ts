/**
 * Japan Meteorological Agency (JMA) station snow records from 過去の気象データ検索 ("historical weather data
 * search"), read by scripts/fetch-obs.ts. There is no API: one HTML page per station and month, e.g.
 * `…/etrn/view/daily_s1.php?prec_no=16&block_no=47433&year=2026&month=02&day=&view=` (`daily_s1` serves the
 * "s" stations, observatories and special regional weather stations, whose block_no is the WMO index; AMeDAS-only
 * sites have four-digit block numbers and `daily_a1` pages, not supported here, so parseJmaSourceId rejects them).
 *
 * Each page's main table (`#tablefix1`) has one row per day of the month and, under 雪(cm), two columns:
 *  - 降雪 合計: the day's snowfall, the sum of the hourly snow-depth gains over the JST day (00–24). Before the
 *    automatic gauge (Kutchan: early 1998) it was the sum of the 09, 15 and 21 JST snow-board readings, 21–21 JST.
 *  - 最深積雪 値: the day's maximum snow depth, not a reading at a fixed time (before the gauge: the largest of
 *    those three readings).
 * The current month is filled through yesterday (JST); JMA updates the daily values at about 01:00 JST.
 *
 * Value flags (値欄の記号の説明, https://www.data.jma.go.jp/stats/data/mdrr/man/remark.html):
 *  - `--`   no phenomenon (none, or under 1 cm at gauge stations) → 0
 *  - `)`    quasi-normal: some input missing but within tolerance; JMA treats it as normal → kept
 *  - `]`    insufficient data: too much input missing, "the value itself can't be trusted" → null
 *  - `×`    missing → null;  `///` missing or not observed → null;  blank: not observed / not published → null
 *  - `#`    value highly doubtful, not shown → null
 *  - `*`    marks the latest of tied dates for an extreme → kept
 * Anything else, a header that moved or a page for another month throws, so a layout change fails loudly.
 */
import { setVal, type Daily } from './obs-file';

export const JMA_ETRN = 'https://www.data.jma.go.jp/stats/etrn';
/** First month the one-time history run fetches: the start of the 1991–2020 WMO normals period. */
export const JMA_HISTORY_FROM = '1991-10';
/** Months fetched (the climatology's Oct 1 – Jun 30 season); July–September are never requested. */
export const JMA_SEASON_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6];

export interface JmaMonth {
  year: number;
  month: number;
}

/** A station's `sourceId` is `prec_no:block_no` of its 過去の気象データ pages, e.g. `16:47433` (後志, Kutchan). */
export function parseJmaSourceId(sourceId: string): { prec: string; block: string } {
  const m = /^(\d{2}):(\d{5})$/.exec(sourceId);
  if (!m) throw new Error(`JMA sourceId must be prec_no:block_no, got ${sourceId}`);
  return { prec: m[1], block: m[2] };
}

export function jmaDailyUrl(prec: string, block: string, { year, month }: JmaMonth): string {
  return `${JMA_ETRN}/view/daily_s1.php?prec_no=${prec}&block_no=${block}&year=${year}&month=${String(month).padStart(2, '0')}&day=&view=`;
}

/** The station's index page in 過去の気象データ検索 (the UI's source link). */
export const jmaStationUrl = (prec: string, block: string) => `${JMA_ETRN}/index.php?prec_no=${prec}&block_no=${block}&year=&month=&day=&view=`;

const ym = ({ year, month }: JmaMonth) => year * 12 + month - 1;
const fromYm = (n: number): JmaMonth => ({ year: Math.floor(n / 12), month: (n % 12) + 1 });

/** Season months (Oct–Jun) from `from` to `to` inclusive, both `YYYY-MM`. */
export function jmaMonths(from: string, to: string): JmaMonth[] {
  const [a, b] = [from, to].map((s) => {
    const [year, month] = s.split('-').map(Number);
    return ym({ year, month });
  });
  const out: JmaMonth[] = [];
  for (let n = a; n <= b; n++) {
    const m = fromYm(n);
    if (JMA_SEASON_MONTHS.includes(m.month)) out.push(m);
  }
  return out;
}

export type JmaMode = 'recent' | 'full' | 'history';

/**
 * The months a run fetches, for today's JST date:
 *  - recent: this month and last month (2 pages; none in August and September, 1 in July and October);
 *  - full:   the current and previous season, from October a year before the current season began (≤ 18 pages);
 *  - history: everything from JMA_HISTORY_FROM (about 320 pages; run once, locally).
 */
export function jmaPlan(mode: JmaMode, todayJst: string): JmaMonth[] {
  const [y, m] = todayJst.split('-').map(Number);
  const to = `${y}-${String(m).padStart(2, '0')}`;
  if (mode === 'history') return jmaMonths(JMA_HISTORY_FROM, to);
  if (mode === 'full') return jmaMonths(`${(m >= 10 ? y : y - 1) - 1}-10`, to);
  const prev = fromYm(ym({ year: y, month: m }) - 1);
  return jmaMonths(`${prev.year}-${String(prev.month).padStart(2, '0')}`, to);
}

export type JmaFlag = 'none' | 'quasi' | 'insufficient' | 'missing' | 'unobserved' | 'doubtful' | 'blank';

export interface JmaDay {
  date: string;
  /** 最深積雪: the day's maximum snow depth. */
  depthCm: number | null;
  /** 降雪 合計: the day's snowfall. */
  newSnowCm: number | null;
}

export interface JmaPage extends JmaMonth {
  /** Days before `todayJst` only (later rows are blank until JMA fills them). */
  days: JmaDay[];
  /** How many snow cells carried each flag (plain numbers aren't counted). */
  flags: Partial<Record<JmaFlag, number>>;
}

/**
 * One cell of the snow columns, per JMA's value-flag table (see the file comment). A value may carry a `)`, `]`
 * or `*` mark, `--` included: `-- )` is none with some input missing (0), `-- ]` none on too little input (null).
 */
export function jmaValue(text: string): { value: number | null; flag?: JmaFlag } {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s === '') return { value: null, flag: 'blank' };
  if (s.includes('×')) return { value: null, flag: 'missing' };
  if (s.includes('#')) return { value: null, flag: 'doubtful' };
  const m = /^(--|\/\/\/|\d+(?:\.\d+)?) ?([)\]*])?$/.exec(s);
  if (!m) throw new Error(`unexpected JMA value "${s}"`);
  const [, base, mark] = m;
  if (base === '///') return { value: null, flag: 'unobserved' };
  if (mark === ']') return { value: null, flag: 'insufficient' };
  const value = base === '--' ? 0 : Number(base);
  if (mark === ')') return { value, flag: 'quasi' };
  return base === '--' ? { value, flag: 'none' } : { value };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|[a-z]+);/g, (e, n: string) => (n[0] === '#' ? String.fromCodePoint(Number(n.slice(1))) : (ENTITIES[n] ?? e)))
    .replace(/\s+/g, ' ')
    .trim();

interface Cell {
  th: boolean;
  text: string;
  rowspan: number;
  colspan: number;
}

function rowsOf(table: string): Cell[][] {
  const span = (attrs: string, name: string) => Number(new RegExp(`\\b${name}=["']?(\\d+)`).exec(attrs)?.[1] ?? 1);
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map(([, tag, attrs, body]) => ({
      th: tag === 'th',
      text: textOf(body),
      rowspan: span(attrs, 'rowspan'),
      colspan: span(attrs, 'colspan'),
    })),
  );
}

/** Each column's header path, top to bottom (e.g. `雪(cm)/最深積雪/値`), from the header rows' row and column spans. */
function headerPaths(rows: Cell[][]): string[] {
  const grid: (string | undefined)[][] = rows.map(() => []);
  rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row) {
      while (grid[r][c] !== undefined) c++;
      for (let dr = 0; dr < cell.rowspan && r + dr < rows.length; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) grid[r + dr][c + dc] = cell.text;
      }
      c += cell.colspan;
    }
  });
  const width = grid[0]?.length ?? 0;
  if (!width || grid.some((g) => g.length !== width || g.includes(undefined))) throw new Error('JMA page: ragged header');
  return Array.from({ length: width }, (_, c) => grid.map((g) => g[c]!).filter((x, r, all) => r === 0 || x !== all[r - 1]).join('/'));
}

const DAY = '日';
const NEW_SNOW = '雪(cm)/降雪/合計';
const MAX_DEPTH = '雪(cm)/最深積雪/値';

/**
 * Parses a `daily_s1` page for `year`-`month` into daily depth and new snow. Throws if the page isn't that month's,
 * a header moved, a row doesn't fit the header, a cell holds anything unexpected, or a month that has ended
 * has no snow value at all.
 */
export function parseJmaDaily(html: string, { year, month }: JmaMonth, todayJst: string): JmaPage {
  const heading = textOf(/<h3\b[^>]*>([\s\S]*?)<\/h3>/.exec(html)?.[1] ?? '');
  if (!heading.includes(`${year}年${month}月（日ごとの値）`)) throw new Error(`JMA page is not the daily page for ${year}-${month} ("${heading}")`);
  const table = /<table\b[^>]*\bid=["']tablefix1["'][^>]*>([\s\S]*?)<\/table>/.exec(html)?.[1];
  if (!table) throw new Error('JMA page has no data table');
  const rows = rowsOf(table).filter((r) => r.length);
  const nHead = rows.findIndex((r) => !r.every((c) => c.th));
  if (nHead < 1) throw new Error('JMA page: no header rows');
  const paths = headerPaths(rows.slice(0, nHead));
  const col = (path: string) => {
    const i = paths.indexOf(path);
    if (i < 0 || paths.indexOf(path, i + 1) >= 0) throw new Error(`JMA page: header ${path} not found once (have ${paths.join(', ')})`);
    return i;
  };
  if (paths[0] !== DAY) throw new Error('JMA page: first column is not the day');
  const [iNew, iDepth] = [col(NEW_SNOW), col(MAX_DEPTH)];
  const body = rows.slice(nHead);
  const nDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (body.length !== nDays) throw new Error(`JMA page: ${body.length} day rows for ${year}-${month}, expected ${nDays}`);
  const flags: JmaPage['flags'] = {};
  const days: JmaDay[] = [];
  body.forEach((cells, i) => {
    if (cells.length !== paths.length || cells.some((c) => c.th || c.rowspan !== 1 || c.colspan !== 1)) {
      throw new Error(`JMA page: row ${i + 1} doesn't fit the header`);
    }
    if (cells[0].text !== String(i + 1)) throw new Error(`JMA page: row ${i + 1} is day "${cells[0].text}"`);
    const date = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
    if (date >= todayJst) return; // filled from about 01:00 JST the next day
    const [depth, snow] = [jmaValue(cells[iDepth].text), jmaValue(cells[iNew].text)];
    for (const f of [depth.flag, snow.flag]) if (f) flags[f] = (flags[f] ?? 0) + 1;
    days.push({ date, depthCm: depth.value, newSnowCm: snow.value });
  });
  const lastDay = `${year}-${String(month).padStart(2, '0')}-${String(nDays).padStart(2, '0')}`;
  if (lastDay < todayJst && !days.some((d) => d.depthCm != null || d.newSnowCm != null)) {
    throw new Error(`JMA page for ${year}-${month} has no snow values`);
  }
  return { year, month, days, flags };
}

/**
 * The previous record with each fetched month replaced by its page: a day JMA now shows as missing or flagged
 * is dropped rather than kept from an earlier fetch. Months not fetched are left as they were.
 */
export function mergeJmaMonths(previous: Daily, pages: JmaPage[]): Daily {
  const d: Daily = new Map(previous);
  for (const p of pages) {
    const prefix = `${p.year}-${String(p.month).padStart(2, '0')}-`;
    for (const date of [...d.keys()]) if (date.startsWith(prefix)) d.delete(date);
    for (const day of p.days) {
      setVal(d, day.date, 'depth', day.depthCm);
      setVal(d, day.date, 'newSnow', day.newSnowCm);
    }
  }
  return d;
}
