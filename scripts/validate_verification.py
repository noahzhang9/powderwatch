#!/usr/bin/env python3
"""Validate forecast-verification records and re-serialise them into the archive tree.

Run by the workflow's `archive` job (system python3, standard library only, no npm code) on the
artifact the read-only build job produced, before anything is committed to the `data/verification`
branch. Also run locally for the one-time backfill (README, "Forecast-verification archive").

    python3 -I validate_verification.py --kind cycle INCOMING_DIR ARCHIVE_ROOT
    python3 -I validate_verification.py --kind backfill INCOMING_DIR ARCHIVE_ROOT
    python3 -I validate_verification.py --check FILE...        # validate only, write nothing

Every incoming file must pass, or nothing is written (exit 1). Accepted files are parsed, checked
against an allowed key set with finite, bounded numbers, and written back with json.dump (never
copied byte for byte) to ARCHIVE_ROOT/cycles/YYYY-MM/<name> or ARCHIVE_ROOT/backfill/YYYY-MM/<name>.
The archive is append-only: an existing file is never overwritten (the first run to carry a cycle wins).

Keep in step with scripts/verification.ts (record builder) and scripts/backfill-verification.ts.
"""
import json
import math
import os
import re
import sys

MAX_BYTES = 512_000
MAX_FILES = {'cycle': 4, 'backfill': 400}
NAME = {
    'cycle': re.compile(r'(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3])Z\.json'),
    'backfill': re.compile(r'(\d{4})-(\d{2})-(\d{2})\.json'),
}
DATE = re.compile(r'\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])')
STAMP = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z')
RESORT = re.compile(r'[a-z][a-z0-9-]{0,31}')
POINT_ID = re.compile(r'[A-Za-z0-9-]{1,40}')
MODEL_ID = re.compile(r'[a-z0-9_]{1,48}')
TZ = re.compile(r'[A-Za-z_]+(/[A-Za-z_+-]+){0,2}')

DAYS = 10            # cycle records: local days 1-10
LEADS = 7            # backfill records: previous_day1..7
MAX_POINTS = 60
MAX_MODELS = 16
MAX_THRESHOLDS = 8

# Daily values: (low, high) per field. Metric units: cm, mm, degC, m.
FIELD_BOUNDS = {
    'snow': (0, 500), 'precip': (0, 1500), 'rain': (0, 1500),
    'tmin': (-80, 60), 'tmax': (-80, 60),
    'slmin': (-1000, 10000), 'slmax': (-1000, 10000),
    'centres': (0, 20),
}
MODEL_FIELDS = tuple(k for k in FIELD_BOUNDS if k != 'centres')
SKIP_REASONS = {'no-projection', 'not-in-snapshot'}


class Invalid(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise Invalid(msg)


def reject_constant(c):
    raise Invalid(f'non-finite number {c}')


def no_duplicates(pairs):
    out = {}
    for k, v in pairs:
        need(k not in out, f'duplicate key {k!r}')
        out[k] = v
    return out


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def num(x, lo, hi, where):
    need(is_num(x) and lo <= x <= hi, f'{where}: expected a number in [{lo}, {hi}], got {x!r}')
    return x


def text(x, pattern, where):
    need(isinstance(x, str) and pattern.fullmatch(x) is not None, f'{where}: unexpected value {x!r}')
    return x


def keys(obj, required, optional, where):
    need(isinstance(obj, dict), f'{where}: expected an object')
    extra = set(obj) - set(required) - set(optional)
    need(not extra, f'{where}: unexpected keys {sorted(extra)}')
    missing = set(required) - set(obj)
    need(not missing, f'{where}: missing keys {sorted(missing)}')


def series(x, n, lo, hi, where):
    need(isinstance(x, list) and len(x) == n, f'{where}: expected {n} values')
    for i, v in enumerate(x):
        if v is not None:
            num(v, lo, hi, f'{where}[{i}]')


def fields(obj, n, where, allowed=tuple(FIELD_BOUNDS)):
    keys(obj, (), allowed, where)
    need(obj, f'{where}: empty')
    for k, v in obj.items():
        series(v, n, *FIELD_BOUNDS[k], f'{where}.{k}')


def models(obj, n, where, allowed=MODEL_FIELDS):
    need(isinstance(obj, dict) and len(obj) <= MAX_MODELS, f'{where}: expected at most {MAX_MODELS} models')
    for mid, f in obj.items():
        text(mid, MODEL_ID, f'{where} id')
        fields(f, n, f'{where}.{mid}', allowed)


def quantiles(obj, n, hi, where):
    keys(obj, ('p10', 'p50', 'p90'), (), where)
    for k, v in obj.items():
        series(v, n, 0, hi, f'{where}.{k}')


def chances(x, n, t, where):
    need(isinstance(x, list) and len(x) == n, f'{where}: expected {n} rows')
    for i, row in enumerate(x):
        series(row, t, 0, 1, f'{where}[{i}]')


def ensemble(obj, n, t, where):
    if obj is None:
        return
    keys(obj, ('ensembles', 'members', 'centres', 'snow', 'precip', 'pge', 'win'), (), where)
    need(isinstance(obj['ensembles'], list) and 0 < len(obj['ensembles']) <= 12, f'{where}.ensembles')
    for e in obj['ensembles']:
        text(e, MODEL_ID, f'{where}.ensembles')
    need(isinstance(obj['members'], int) and not isinstance(obj['members'], bool) and 0 < obj['members'] <= 1000, f'{where}.members')
    series(obj['centres'], n, 0, 20, f'{where}.centres')
    quantiles(obj['snow'], n, 500, f'{where}.snow')
    quantiles(obj['precip'], n, 1500, f'{where}.precip')
    chances(obj['pge'], n, t, f'{where}.pge')
    win = obj['win']
    keys(win, ('days', 'snow', 'pge'), (), f'{where}.win')
    need(isinstance(win['days'], list) and 0 < len(win['days']) <= 5, f'{where}.win.days')
    for d in win['days']:
        need(isinstance(d, int) and not isinstance(d, bool) and 1 <= d <= n, f'{where}.win.days: {d!r}')
    w = len(win['days'])
    quantiles(win['snow'], w, 3000, f'{where}.win.snow')
    chances(win['pge'], w, t, f'{where}.win.pge')


WPC_DAYS = 3
WPC_THRESHOLDS = 3
WPC_STAMP = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z')


def wpc(obj, where):
    """WPC Day 1-3 categories (0-3, or null) for >= 4/8/12 in, with each day's period."""
    keys(obj, ('days', 'cat'), (), where)
    need(isinstance(obj['days'], list) and len(obj['days']) == WPC_DAYS, f'{where}.days')
    for i, d in enumerate(obj['days']):
        if d is None:
            continue
        keys(d, ('start', 'end', 'issued'), (), f'{where}.days[{i}]')
        for k in ('start', 'end', 'issued'):
            text(d[k], WPC_STAMP, f'{where}.days[{i}].{k}')
    need(isinstance(obj['cat'], list) and len(obj['cat']) == WPC_DAYS, f'{where}.cat')
    for i, row in enumerate(obj['cat']):
        need(isinstance(row, list) and len(row) == WPC_THRESHOLDS, f'{where}.cat[{i}]')
        for c in row:
            need(c is None or (isinstance(c, int) and not isinstance(c, bool) and 0 <= c <= 3), f'{where}.cat[{i}]: {c!r}')


def dates(x, n, where):
    need(isinstance(x, list) and len(x) == n, f'{where}: expected {n} dates')
    for d in x:
        text(d, DATE, where)
    need(x == sorted(set(x)), f'{where}: dates must be distinct and increasing')


def point_head(p, where):
    text(p['resort'], RESORT, f'{where}.resort')
    need(p['kind'] in ('mid', 'station'), f'{where}.kind')
    text(p['id'], POINT_ID, f'{where}.id')
    need(p['kind'] != 'mid' or p['id'] == 'mid', f'{where}: a mid point has id "mid"')
    num(p['lat'], -90, 90, f'{where}.lat')
    num(p['lon'], -180, 180, f'{where}.lon')
    num(p['elev'], -500, 9000, f'{where}.elev')
    text(p['tz'], TZ, f'{where}.tz')


def check_cycle(rec, stem):
    keys(rec, ('v', 'kind', 'cycle', 'generatedAt', 'thresholdsCm', 'runs', 'lagging', 'points', 'skipped'), (), 'record')
    need(rec['v'] == 1 and rec['kind'] == 'cycle', 'record: unsupported version or kind')
    need(rec['cycle'] == stem, f'record: cycle {rec["cycle"]!r} does not match the file name')
    text(rec['generatedAt'], STAMP, 'generatedAt')
    th = rec['thresholdsCm']
    need(isinstance(th, list) and 0 < len(th) <= MAX_THRESHOLDS, 'thresholdsCm')
    for x in th:
        num(x, 0, 200, 'thresholdsCm')
    t = len(th)
    need(isinstance(rec['runs'], dict) and len(rec['runs']) <= 32, 'runs')
    for mid, run in rec['runs'].items():
        text(mid, MODEL_ID, 'runs id')
        if run is not None:
            text(run, STAMP, f'runs.{mid}')
    need(isinstance(rec['lagging'], list) and len(rec['lagging']) <= MAX_MODELS, 'lagging')
    for mid in rec['lagging']:
        text(mid, MODEL_ID, 'lagging')
    need(isinstance(rec['points'], list) and 0 < len(rec['points']) <= MAX_POINTS, 'points')
    seen = set()
    for i, p in enumerate(rec['points']):
        where = f'points[{i}]'
        keys(p, ('resort', 'kind', 'id', 'lat', 'lon', 'elev', 'tz', 'days', 'models', 'ens'), ('blend', 'nbm', 'wpc'), where)
        point_head(p, where)
        need((p['resort'], p['id']) not in seen, f'{where}: duplicate point')
        seen.add((p['resort'], p['id']))
        dates(p['days'], DAYS, f'{where}.days')
        if 'blend' in p:
            need(p['kind'] == 'mid', f'{where}: only mid points have a blend')
            fields(p['blend'], DAYS, f'{where}.blend')
        if 'nbm' in p:
            need(p['kind'] == 'mid', f'{where}: only mid points have NBM')
            fields(p['nbm'], DAYS, f'{where}.nbm', MODEL_FIELDS)
        if 'wpc' in p:
            need(p['kind'] == 'mid', f'{where}: only mid points have WPC chances')
            wpc(p['wpc'], f'{where}.wpc')
        models(p['models'], DAYS, f'{where}.models')
        ensemble(p['ens'], DAYS, t, f'{where}.ens')
    need(isinstance(rec['skipped'], list) and len(rec['skipped']) <= MAX_POINTS, 'skipped')
    for i, s in enumerate(rec['skipped']):
        keys(s, ('resort', 'id', 'reason'), (), f'skipped[{i}]')
        text(s['resort'], RESORT, f'skipped[{i}].resort')
        text(s['id'], POINT_ID, f'skipped[{i}].id')
        need(s['reason'] in SKIP_REASONS, f'skipped[{i}].reason')


def check_backfill(rec, stem):
    keys(rec, ('v', 'kind', 'date', 'generatedAt', 'source', 'leads', 'points'), (), 'record')
    need(rec['v'] == 1 and rec['kind'] == 'backfill', 'record: unsupported version or kind')
    need(rec['date'] == stem, f'record: date {rec["date"]!r} does not match the file name')
    text(rec['date'], DATE, 'date')
    text(rec['generatedAt'], STAMP, 'generatedAt')
    need(rec['source'] == 'open-meteo-previous-runs', 'source')
    need(rec['leads'] == list(range(1, LEADS + 1)), 'leads')
    need(isinstance(rec['points'], list) and 0 < len(rec['points']) <= MAX_POINTS, 'points')
    seen = set()
    for i, p in enumerate(rec['points']):
        where = f'points[{i}]'
        keys(p, ('resort', 'kind', 'id', 'lat', 'lon', 'elev', 'tz', 'models'), (), where)
        point_head(p, where)
        need((p['resort'], p['id']) not in seen, f'{where}: duplicate point')
        seen.add((p['resort'], p['id']))
        models(p['models'], LEADS, f'{where}.models', ('snow', 'precip', 'rain', 'tmin', 'tmax'))


def load(path):
    need(os.path.isfile(path) and not os.path.islink(path), f'{path}: not a regular file')
    need(os.path.getsize(path) <= MAX_BYTES, f'{path}: larger than {MAX_BYTES} bytes')
    with open(path, encoding='utf-8') as fh:
        try:
            return json.load(fh, parse_constant=reject_constant, object_pairs_hook=no_duplicates)
        except ValueError as err:
            raise Invalid(f'{path}: not valid JSON ({err})')


def validate(path, kind):
    """Returns (record, destination relative to the archive root); raises Invalid."""
    name = os.path.basename(path)
    m = NAME[kind].fullmatch(name)
    need(m is not None, f'unexpected file name {name!r}')
    stem = name[:-len('.json')]
    rec = load(path)
    try:
        (check_cycle if kind == 'cycle' else check_backfill)(rec, stem)
    except Invalid as err:
        raise Invalid(f'{name}: {err}')
    folder = 'cycles' if kind == 'cycle' else 'backfill'
    return rec, os.path.join(folder, f'{m.group(1)}-{m.group(2)}', name)


def kind_of(name):
    for kind, pattern in NAME.items():
        if pattern.fullmatch(name):
            return kind
    return None


def main(argv):
    if argv[:1] == ['--check']:
        for path in argv[1:]:
            kind = kind_of(os.path.basename(path))
            need(kind is not None, f'unexpected file name {os.path.basename(path)!r}')
            validate(path, kind)
            print(f'ok {path}')
        return 0
    need(len(argv) == 4 and argv[0] == '--kind' and argv[1] in NAME, 'usage: --kind cycle|backfill INCOMING_DIR ARCHIVE_ROOT')
    kind, incoming, root = argv[1], argv[2], argv[3]
    need(os.path.isdir(incoming) and os.path.isdir(root), 'INCOMING_DIR and ARCHIVE_ROOT must be directories')
    names = sorted(os.listdir(incoming))
    need(0 < len(names) <= MAX_FILES[kind], f'expected 1 to {MAX_FILES[kind]} incoming files, got {len(names)}')
    accepted = [validate(os.path.join(incoming, n), kind) for n in names]  # all pass, or nothing is written
    for rec, rel in accepted:
        dest = os.path.join(root, rel)
        if os.path.lexists(dest):
            print(f'exists, kept: {rel}')
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'x', encoding='utf-8') as out:
            json.dump(rec, out, allow_nan=False, separators=(',', ':'), ensure_ascii=True)
            out.write('\n')
        print(f'added: {rel}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Invalid as err:
        sys.exit(f'rejected: {err}')
