import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jmaDailyUrl, jmaMonths, jmaPlan, jmaValue, mergeJmaMonths, parseJmaDaily, parseJmaSourceId, type JmaPage } from './jma';
import type { Daily } from './obs-file';

/** Kutchan (倶知安, block 47433) pages, trimmed: see each file's first line. */
const fixture = (ym: string) => readFileSync(new URL(`./fixtures/jma-47433-${ym}.html`, import.meta.url), 'utf-8');
const JAN_2005 = fixture('2005-01');
const FEB_2026 = fixture('2026-02');
const NOV_2026 = fixture('2026-11');
const LATER = '2026-11-21';

const day = (p: JmaPage, date: string) => p.days.find((d) => d.date === date);

describe('JMA daily pages', () => {
  it('reads the day’s maximum depth and new snow from a normal month', () => {
    const p = parseJmaDaily(JAN_2005, { year: 2005, month: 1 }, LATER);
    expect(p.days).toHaveLength(31);
    expect(day(p, '2005-01-01')).toEqual({ date: '2005-01-01', depthCm: 89, newSnowCm: 9 });
    expect(day(p, '2005-01-31')).toEqual({ date: '2005-01-31', depthCm: 161, newSnowCm: 27 });
    expect(p.days.every((d) => d.depthCm != null && d.newSnowCm != null)).toBe(true);
    expect(p.flags).toEqual({ none: 1 });
  });

  it('drops values JMA flags as insufficient (]) and reads -- as none', () => {
    const p = parseJmaDaily(FEB_2026, { year: 2026, month: 2 }, LATER);
    expect(p.days).toHaveLength(28);
    expect(day(p, '2026-02-19')).toEqual({ date: '2026-02-19', depthCm: null, newSnowCm: null }); // "138 ]", "1 ]"
    expect(day(p, '2026-02-20')).toEqual({ date: '2026-02-20', depthCm: 131, newSnowCm: 0 }); // new snow "--"
    expect(p.flags).toEqual({ none: 7, insufficient: 2 });
  });

  it('stores -- as 0, so a snow-free start of season is complete, and stops before today', () => {
    const p = parseJmaDaily(NOV_2026, { year: 2026, month: 11 }, LATER);
    expect(p.days.map((d) => d.date.slice(8))).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, '0')));
    expect(day(p, '2026-11-01')).toEqual({ date: '2026-11-01', depthCm: 0, newSnowCm: 0 });
    expect(day(p, '2026-11-09')).toEqual({ date: '2026-11-09', depthCm: 48, newSnowCm: 38 });
    expect(parseJmaDaily(NOV_2026, { year: 2026, month: 11 }, '2026-11-10').days.at(-1)!.date).toBe('2026-11-09');
  });

  it('accepts a current month with nothing filled in yet', () => {
    expect(parseJmaDaily(NOV_2026, { year: 2026, month: 11 }, '2026-11-01').days).toEqual([]);
  });

  it('rejects a changed layout or another month’s page', () => {
    const month = { year: 2005, month: 1 };
    expect(() => parseJmaDaily(JAN_2005, { year: 2005, month: 2 }, LATER)).toThrow(/not the daily page for 2005-2/);
    expect(() => parseJmaDaily(JAN_2005.replace('最深積雪', '積雪'), month, LATER)).toThrow(/雪\(cm\)\/最深積雪\/値 not found/);
    expect(() => parseJmaDaily(JAN_2005.replace('<th scope="col">合計</th><th scope="col">値</th>', '<th scope="col">値</th><th scope="col">合計</th>'), month, LATER)).toThrow(/not found/);
    expect(() => parseJmaDaily(JAN_2005.replace('雪(cm)', '雪(mm)'), month, LATER)).toThrow(/not found/);
    // A column more in the header than in the rows, a row less than the month has, no table at all.
    expect(() => parseJmaDaily(JAN_2005.replace('<th scope="col">値</th>', '<th scope="col">値</th><th rowspan="4">新</th>'), month, LATER)).toThrow();
    expect(() => parseJmaDaily(JAN_2005.replace(/<tr class="mtx"><td>31<\/td>.*?<\/tr>/, ''), month, LATER)).toThrow(/30 day rows/);
    expect(() => parseJmaDaily(JAN_2005.replace("id='tablefix1'", "id='tablefix2'"), month, LATER)).toThrow(/no data table/);
    expect(() => parseJmaDaily(JAN_2005.replace('<td>161</td>', '<td>161 ?</td>'), month, LATER)).toThrow(/unexpected JMA value "161 \?"/);
  });

  it('rejects a month that has ended with no snow value at all', () => {
    // Every cell but the day emptied, as a page that came back without data would be.
    const blank = JAN_2005.replace(/(<tr class="mtx"><td>\d+<\/td>)(.*)(<\/tr>)/g, (_, head: string, cells: string, end: string) => head + cells.replace(/<td>[^<]*<\/td>/g, '<td></td>') + end);
    expect(blank.match(/<td><\/td>/g)).toHaveLength(31 * 20);
    expect(() => parseJmaDaily(blank, { year: 2005, month: 1 }, LATER)).toThrow(/no snow values/);
    expect(parseJmaDaily(blank, { year: 2005, month: 1 }, '2005-01-31').days.every((d) => d.depthCm == null)).toBe(true); // not ended yet
  });
});

describe('JMA value flags', () => {
  it('follows JMA’s value-flag table', () => {
    expect(jmaValue('142')).toEqual({ value: 142 });
    expect(jmaValue('0')).toEqual({ value: 0 }); // some snow, under 1 cm
    expect(jmaValue('--')).toEqual({ value: 0, flag: 'none' });
    expect(jmaValue('79 )')).toEqual({ value: 79, flag: 'quasi' });
    expect(jmaValue('79)')).toEqual({ value: 79, flag: 'quasi' });
    expect(jmaValue('138 ]')).toEqual({ value: null, flag: 'insufficient' });
    expect(jmaValue('-- )')).toEqual({ value: 0, flag: 'quasi' }); // none, some input missing (Kutchan, Oct 2009)
    expect(jmaValue('-- ]')).toEqual({ value: null, flag: 'insufficient' }); // none, but on too little input
    expect(jmaValue('/// )')).toEqual({ value: null, flag: 'unobserved' });
    expect(jmaValue('×')).toEqual({ value: null, flag: 'missing' });
    expect(jmaValue('///')).toEqual({ value: null, flag: 'unobserved' });
    expect(jmaValue('#')).toEqual({ value: null, flag: 'doubtful' });
    expect(jmaValue(' ')).toEqual({ value: null, flag: 'blank' });
    expect(jmaValue('120*')).toEqual({ value: 120 });
  });
  it('throws on anything else', () => {
    for (const s of ['-3', '12 cm', '1,2', 'abc', '))']) expect(() => jmaValue(s)).toThrow(/unexpected JMA value/);
  });
});

describe('JMA requests', () => {
  it('builds the daily page URL from prec_no:block_no', () => {
    const { prec, block } = parseJmaSourceId('16:47433');
    expect(jmaDailyUrl(prec, block, { year: 2026, month: 2 })).toBe(
      'https://www.data.jma.go.jp/stats/etrn/view/daily_s1.php?prec_no=16&block_no=47433&year=2026&month=02&day=&view=',
    );
    expect(() => parseJmaSourceId('16217')).toThrow();
  });

  it('fetches only October to June', () => {
    expect(jmaMonths('2025-06', '2025-11').map((m) => m.month)).toEqual([6, 10, 11]);
  });

  it('plans two pages for an update, two seasons for a full refresh, 1991 on for the history', () => {
    const ym = (ms: { year: number; month: number }[]) => ms.map((m) => `${m.year}-${String(m.month).padStart(2, '0')}`);
    expect(ym(jmaPlan('recent', '2026-11-21'))).toEqual(['2026-10', '2026-11']);
    expect(ym(jmaPlan('recent', '2027-01-01'))).toEqual(['2026-12', '2027-01']);
    expect(ym(jmaPlan('recent', '2026-10-05'))).toEqual(['2026-10']);
    expect(jmaPlan('recent', '2026-08-15')).toEqual([]);
    const full = ym(jmaPlan('full', '2026-11-21'));
    expect([full[0], full.at(-1), full.length]).toEqual(['2025-10', '2026-11', 11]);
    const fullSpring = ym(jmaPlan('full', '2027-03-02'));
    expect([fullSpring[0], fullSpring.at(-1), fullSpring.length]).toEqual(['2025-10', '2027-03', 15]);
    const history = ym(jmaPlan('history', '2026-11-21'));
    expect([history[0], history.at(-1), history.length]).toEqual(['1991-10', '2026-11', 35 * 9 + 2]);
  });
});

describe('JMA merge', () => {
  it('replaces the fetched months and keeps the rest', () => {
    const previous: Daily = new Map([
      ['2026-01-31', { depth: 150, newSnow: 3 }],
      ['2026-02-18', { depth: 140, newSnow: 1 }],
      ['2026-02-19', { depth: 139, newSnow: 1 }], // now flagged ]: dropped
    ]);
    const merged = mergeJmaMonths(previous, [parseJmaDaily(FEB_2026, { year: 2026, month: 2 }, LATER)]);
    expect(merged.get('2026-01-31')).toEqual({ depth: 150, newSnow: 3 });
    expect(merged.get('2026-02-18')).toEqual({ depth: 146, newSnow: 14 });
    expect(merged.has('2026-02-19')).toBe(false);
    expect([...merged.keys()].filter((d) => d.startsWith('2026-02'))).toHaveLength(27);
    expect(previous.get('2026-02-18')).toEqual({ depth: 140, newSnow: 1 }); // input untouched
  });
});
