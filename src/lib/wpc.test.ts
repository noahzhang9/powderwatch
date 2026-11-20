import { describe, expect, it } from 'vitest';
import { RESORTS } from '../config/resorts';
import {
  WPC_LAYERS, buildWpcFile, parseLayerTimes, parsePointCategory, parseWpcFile, wpcPoints, wpcPointUrl, wpcTime, type WpcFile,
} from './wpc';

/** A feature as WPC's service returns it (point query, outFields=*). */
const feature = (dn: number, outlook: string, day = 1, issue = '2026-11-19 20:29:08') => ({
  attributes: {
    objectid: dn, id: dn, product: `Day ${day} probability of snow greater than 4 inches`,
    valid_time: '00Z 11/20/26 - 00Z 11/21/26', outlook, issue_time: issue,
    start_time: `2026-11-${19 + day} 00:00:00`, end_time: `2026-11-${20 + day} 00:00:00`,
    idp_source: 'wwd_day1_psnow_gt_04', dn,
  },
});
const query = (...features: unknown[]) => ({ displayFieldName: 'product', fields: [], features });
const SLIGHT = 'Slight (10-39%)';
const MODERATE = 'Moderate (40-69%)';
const HIGH = 'High (70-100%)';

describe('WPC parsing', () => {
  it('reads WPC times as UTC', () => {
    expect(wpcTime('2026-11-20 00:00:00')).toBe('2026-11-20T00:00Z');
    expect(wpcTime('00Z 11/20/26')).toBeNull();
    expect(wpcTime(1795120955000)).toBeNull();
  });

  it("takes a point's highest nested polygon, and under 10% outside them all", () => {
    expect(parsePointCategory(query(feature(1, SLIGHT), feature(2, MODERATE), feature(3, HIGH)))?.cat).toBe(3);
    expect(parsePointCategory(query(feature(1, SLIGHT)))).toEqual({ cat: 1, period: { start: '2026-11-20T00:00Z', end: '2026-11-21T00:00Z', issued: '2026-11-19T20:29Z' } });
    expect(parsePointCategory(query())).toEqual({ cat: 0, period: null });
  });

  it('treats failures and inconsistent polygons as unknown, never as under 10%', () => {
    expect(parsePointCategory({ error: { code: 400, message: 'Invalid or missing input parameters.' } })).toBeNull();
    expect(parsePointCategory('<html>504 Gateway Time-out</html>')).toBeNull();
    expect(parsePointCategory(undefined)).toBeNull();
    expect(parsePointCategory({ features: 'none' })).toBeNull();
    expect(parsePointCategory(query(feature(3, SLIGHT)))).toBeNull(); // code and label disagree
    expect(parsePointCategory(query(feature(4, 'Extreme')))).toBeNull();
  });

  it("reads a layer's period, preferring the newest issuance", () => {
    const t = (issue: string, start: string, end: string) => ({ attributes: { issue_time: issue, start_time: start, end_time: end } });
    expect(parseLayerTimes(query(t('2026-11-19 08:30:00', '2026-11-19 12:00:00', '2026-11-20 12:00:00'), t('2026-11-19 20:29:08', '2026-11-20 00:00:00', '2026-11-21 00:00:00'))))
      .toEqual({ start: '2026-11-20T00:00Z', end: '2026-11-21T00:00Z', issued: '2026-11-19T20:29Z' });
    expect(parseLayerTimes(query())).toBeNull(); // no polygons anywhere: no times
    expect(parseLayerTimes({ error: {} })).toBeUndefined();
  });

  it('queries one point per US resort at mid, as given in the brief', () => {
    expect(wpcPoints(RESORTS).map((p) => p.id)).toEqual(['crystal', 'snoqualmie', 'stevens']);
    expect(wpcPointUrl(1, -121.49, 46.931)).toBe(
      'https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_prob_winter_precip/MapServer/1/query?geometry=-121.49,46.931&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json',
    );
  });
});

describe('WPC file', () => {
  const day = (d: number) => ({ attributes: { issue_time: '2026-11-19 20:29:08', start_time: `2026-11-${19 + d} 00:00:00`, end_time: `2026-11-${20 + d} 00:00:00` } });
  const build = (over: { times?: (l: number) => unknown; point?: (l: number, id: string) => unknown } = {}) =>
    buildWpcFile({
      fetchedAt: 1795130000,
      points: [{ id: 'crystal', lat: 46.931, lon: -121.49 }],
      // Day 3 has no polygon anywhere, so its layers have no times.
      times: over.times ?? ((l) => (l >= 11 ? query() : query(day(WPC_LAYERS.findIndex((row) => (row as readonly number[]).includes(l)) + 1)))),
      point: over.point ?? ((l) => (l === 1 ? query(feature(1, SLIGHT), feature(2, MODERATE)) : l === 6 ? query(feature(1, SLIGHT, 2)) : query())),
    });

  it('holds each day’s 24 h period and the categories at each resort', () => {
    const f = build();
    expect(f.days).toEqual([
      { start: '2026-11-20T00:00Z', end: '2026-11-21T00:00Z', issued: '2026-11-19T20:29Z' },
      { start: '2026-11-21T00:00Z', end: '2026-11-22T00:00Z', issued: '2026-11-19T20:29Z' },
      // Inferred: WPC days are consecutive 24 h periods.
      { start: '2026-11-22T00:00Z', end: '2026-11-23T00:00Z', issued: '2026-11-19T20:29Z' },
    ]);
    expect(f.points.crystal.cat).toEqual([[2, 0, 0], [1, 0, 0], [0, 0, 0]]);
  });

  it('leaves a cell unknown when its query failed or it comes from another issuance', () => {
    const f = build({
      point: (l) => (l === 2 ? undefined : l === 1 ? query(feature(1, SLIGHT, 1, '2026-11-19 08:30:00')) : query()),
      times: (l) => (l === 1 ? query({ attributes: { issue_time: '2026-11-19 08:30:00', start_time: '2026-11-19 12:00:00', end_time: '2026-11-20 12:00:00' } }) : l === 2 ? query(day(1)) : query()),
    });
    expect(f.points.crystal.cat[0]).toEqual([null, null, 0]);
  });

  it('round-trips through the browser’s validation, which rejects anything malformed', () => {
    const f = build();
    expect(parseWpcFile(JSON.parse(JSON.stringify(f)))).toEqual(f);
    const bad = (g: (x: WpcFile) => void) => {
      const x = JSON.parse(JSON.stringify(f)) as WpcFile;
      g(x);
      return parseWpcFile(x);
    };
    expect(bad((x) => (x.points.crystal.cat[0][0] = 4 as never))).toBeNull();
    expect(bad((x) => (x.days[0]!.start = '<img src=x>'))).toBeNull();
    expect(bad((x) => (x.points['Crystal<script>'] = x.points.crystal))).toBeNull();
    expect(bad((x) => x.days.pop())).toBeNull();
    expect(bad((x) => (x.v = 2 as never))).toBeNull();
    expect(parseWpcFile(null)).toBeNull();
  });
});
