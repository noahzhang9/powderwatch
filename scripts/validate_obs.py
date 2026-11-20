"""Validate station-observation files from an untrusted job and write them, re-serialised, into DEST.

Run with `python3 -I` by the jobs that hold a write token and run no npm code:

  refresh-and-deploy.yml, commit:   validate_obs.py INCOMING_DIR public/data/obs
  backfill-snodas.yml, commit:      validate_obs.py --backfill INCOMING_DIR... public/data/obs

Each incoming file must be `<id>.json` for a file DEST already has (this never creates a file), hold only the
station-file keys (StationFile in src/lib/obs.ts) with ISO dates, equal-length series and finite numbers within
bounds, and be at most 2 MB. Raw bytes are never copied: what is written is re-serialised from the parsed values.

Modelled SNODAS files (`snodas-*.json`) are merged day by day with the file already in DEST: incoming values
win where they exist and every other day is kept. Their history comes from the backfill workflow, so a refresh
that read the files before a backfill commit landed can't drop that history, and merging the same season
twice changes nothing. Other files are replaced as they come (their source re-sends complete records).

--backfill accepts only SNODAS files, from directories named `snodas-<season>` (one artifact per season).
Exit status 1 with a `rejected: …` message on the first problem; DEST is then left as it was.
"""
import datetime
import json
import os
import re
import sys

DATE = re.compile(r'\d{4}-\d{2}-\d{2}')
STAMP = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z')
NAME = re.compile(r'[A-Za-z0-9-]+\.json')
SEASON_DIR = re.compile(r'snodas-20\d\d')
BOUNDS = {'depthCm': 1500, 'sweMm': 5000, 'newSnowCm': 300}
ALLOWED = {'id', 'updated', 'start', 'depthCm', 'sweMm', 'newSnowCm', 'lastDepthDate', 'lastSweDate'}
MAX_BYTES = 2_000_000
MODELLED = 'snodas-'
# SNODAS's record starts 2003-09-30 (NSIDC G02158).
SNODAS_FIRST = datetime.date(2003, 9, 30)


class Rejected(Exception):
    pass


def reject_constant(c):
    raise Rejected(f'non-finite number {c}')


def as_date(s, what):
    try:
        return datetime.date.fromisoformat(s)
    except ValueError:
        raise Rejected(f'bad {what}') from None


def check(f, name):
    """The checks the commit job has always made, on one parsed file."""
    if not isinstance(f, dict) or set(f) - ALLOWED or not isinstance(f.get('id'), str) or f['id'] + '.json' != name:
        raise Rejected(f'unexpected structure in {name}')
    if not (isinstance(f.get('start'), str) and DATE.fullmatch(f['start'])):
        raise Rejected(f'bad start date in {name}')
    as_date(f['start'], f'start date in {name}')
    if not (isinstance(f.get('updated'), str) and STAMP.fullmatch(f['updated'])):
        raise Rejected(f'bad updated timestamp in {name}')
    for k in ('lastDepthDate', 'lastSweDate'):
        if f.get(k) is not None and not (isinstance(f[k], str) and DATE.fullmatch(f[k])):
            raise Rejected(f'bad {k} in {name}')
    lengths = set()
    for k, hi in BOUNDS.items():
        v = f.get(k)
        if v is None and k != 'depthCm':
            continue
        if not isinstance(v, list):
            raise Rejected(f'bad series {k} in {name}')
        for x in v:
            if x is not None and (isinstance(x, bool) or not isinstance(x, (int, float)) or not 0 <= x <= hi):
                raise Rejected(f'implausible value {x!r} in {k} of {name}')
        lengths.add(len(v))
    if len(lengths) != 1:
        raise Rejected(f'series lengths differ in {name}')
    return f


def load(path, name):
    if os.path.islink(path) or not os.path.isfile(path):
        raise Rejected(f'{name} is not a regular file')
    if os.path.getsize(path) > MAX_BYTES:
        raise Rejected(f'{name} is larger than 2 MB')
    try:
        with open(path, encoding='utf-8') as fh:
            return check(json.load(fh, parse_constant=reject_constant), name)
    except (ValueError, UnicodeDecodeError) as e:
        raise Rejected(f'{name} is not valid JSON: {e}') from None


def by_day(f):
    """{date: {series: value}} for every non-null value."""
    start = as_date(f['start'], 'start date')
    days = {}
    for k in BOUNDS:
        for i, x in enumerate(f.get(k) or []):
            if x is not None:
                days.setdefault(start + datetime.timedelta(days=i), {})[k] = x
    return days


def merge(old, new, name):
    """Day-by-day union of two SNODAS files; `new` wins where it has a value. Same layout as scripts/obs-file.ts."""
    days = by_day(old) if old else {}
    for d, vals in by_day(new).items():
        days.setdefault(d, {}).update(vals)
    if not days:
        raise Rejected(f'{name} has no values')
    first, last = min(days), max(days)
    today = datetime.datetime.now(datetime.timezone.utc).date()
    if first < SNODAS_FIRST or last > today + datetime.timedelta(days=1):
        raise Rejected(f'{name} has days outside {SNODAS_FIRST}..{today}')
    with_depth = [d for d in days if 'depthCm' in days[d]]
    with_swe = [d for d in days if 'sweMm' in days[d]]
    start = min(with_depth + with_swe) if with_depth or with_swe else first
    n = (last - start).days + 1

    def series(k):
        out = [None] * n
        for d, vals in days.items():
            if k in vals and d >= start:
                out[(d - start).days] = vals[k]
        return out

    new_snow = series('newSnowCm')
    return {
        'id': new['id'],
        'updated': max(new['updated'], old['updated']) if old else new['updated'],
        'start': start.isoformat(),
        'depthCm': series('depthCm'),
        'sweMm': series('sweMm') if with_swe else None,
        'newSnowCm': new_snow if any(x is not None for x in new_snow) else None,
        'lastDepthDate': max(with_depth).isoformat() if with_depth else None,
        'lastSweDate': max(with_swe).isoformat() if with_swe else None,
    }


def main(argv):
    backfill = '--backfill' in argv
    args = [a for a in argv if a != '--backfill']
    if len(args) < 2 or any(a.startswith('--') for a in args):
        sys.exit('usage: validate_obs.py [--backfill] INCOMING_DIR... DEST_DIR')
    *sources, dest = args
    existing = set(os.listdir(dest))
    out = {}  # name → serialised file, written only once everything has passed
    for src in sources:
        if backfill and not SEASON_DIR.fullmatch(os.path.basename(os.path.normpath(src))):
            raise Rejected(f'unexpected artifact directory {os.path.basename(src)}')
        for name in sorted(os.listdir(src)):
            if not NAME.fullmatch(name) or name not in existing:
                raise Rejected(f'unexpected file {name}')
            if backfill and not name.startswith(MODELLED):
                raise Rejected(f'{name} is not a SNODAS file')
            f = load(os.path.join(src, name), name)
            if name.startswith(MODELLED):
                if name in out:
                    old = json.loads(out[name])
                else:
                    try:
                        old = load(os.path.join(dest, name), name)
                    except Rejected:
                        old = None  # a damaged file on main is replaced rather than merged
                f = merge(old, f, name)
            body = json.dumps(f, allow_nan=False, separators=(',', ':'))
            if len(body) > MAX_BYTES:
                raise Rejected(f'{name} would be larger than 2 MB')
            out[name] = body
    for name, body in out.items():
        with open(os.path.join(dest, name), 'w', encoding='utf-8') as fh:
            fh.write(body)
    print(f'{len(out)} files validated' + (' and merged' if backfill else ''))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Rejected as e:
        sys.exit(f'rejected: {e}')
