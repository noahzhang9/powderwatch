import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Runs the gate job's script from .github/workflows/refresh-and-deploy.yml as GitHub would (bash -e), with the
// deployed manifest replaced by a local file. Needs python3 with PyYAML (to read the step), bash, curl and GNU date.
const WORKFLOW = fileURLToPath(new URL('../.github/workflows/refresh-and-deploy.yml', import.meta.url));
const extract = spawnSync('python3', ['-I', '-c', [
  'import sys, yaml',
  'd = yaml.safe_load(open(sys.argv[1]))',
  "print(next(s for s in d['jobs']['gate']['steps'] if s.get('id') == 'decide')['run'])",
].join('\n'), WORKFLOW], { encoding: 'utf-8' });
const gnuDate = spawnSync('date', ['-u', '-d', '@0', '+%u']).status === 0;
const usable = extract.status === 0 && gnuDate && spawnSync('curl', ['--version']).status === 0;

const DIR = mkdtempSync(join(tmpdir(), 'pw-gate-'));
const SCRIPT = join(DIR, 'gate.sh');
if (usable) writeFileSync(SCRIPT, extract.stdout);

const at = (iso: string) => Date.parse(iso) / 1000;
const TUE_0820 = at('2026-11-24T08:20:00Z');
const SUN_0020 = at('2026-11-22T00:20:00Z');

interface Case {
  event: 'schedule' | 'workflow_dispatch' | 'push';
  now: number;
  schedule?: string;
  fullInput?: boolean;
  /** Deployed manifest's generatedAt; undefined: no manifest. */
  generatedAt?: number;
}

function gate(c: Case) {
  const out = join(DIR, `out-${Math.random().toString(36).slice(2)}`);
  writeFileSync(out, '');
  const manifest = join(DIR, `manifest-${Math.random().toString(36).slice(2)}.json`);
  if (c.generatedAt !== undefined) writeFileSync(manifest, JSON.stringify({ version: 1, generatedAt: c.generatedAt, entries: {} }));
  const r = spawnSync('bash', ['-e', SCRIPT], {
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH, GITHUB_OUTPUT: out, NOW_S: String(c.now), MANIFEST_URL: `file://${manifest}`,
      EVENT: c.event, SCHEDULE: c.schedule ?? '', FULL_INPUT: c.fullInput ? 'true' : c.event === 'workflow_dispatch' ? 'false' : '',
    },
  });
  expect(r.status, r.stderr).toBe(0);
  const vals = Object.fromEntries(readFileSync(out, 'utf-8').trim().split('\n').map((l) => l.split('=')));
  return { run: vals.run, full: vals.full };
}

describe.skipIf(!usable)('workflow gate (refresh-and-deploy.yml)', () => {
  const EVERY_4H = '20 4,8,12,16,20 * * *';
  const SUNDAY = '20 0 * * 0';

  it('skips a slot the other trigger already ran (deployed snapshot under 2 h old)', () => {
    expect(gate({ event: 'schedule', schedule: EVERY_4H, now: TUE_0820, generatedAt: TUE_0820 - 1800 })).toMatchObject({ run: '0', full: '0' });
    expect(gate({ event: 'workflow_dispatch', now: TUE_0820, generatedAt: TUE_0820 - 1800 })).toMatchObject({ run: '0', full: '0' });
  });

  it('runs when the snapshot is older, missing or unreadable', () => {
    expect(gate({ event: 'schedule', schedule: EVERY_4H, now: TUE_0820, generatedAt: TUE_0820 - 3 * 3600 }).run).toBe('1');
    expect(gate({ event: 'schedule', schedule: EVERY_4H, now: TUE_0820 }).run).toBe('1');
    expect(gate({ event: 'schedule', schedule: EVERY_4H, now: TUE_0820, generatedAt: TUE_0820 + 600 }).run).toBe('1'); // clock skew
  });

  it('never skips pushes or a ticked full refresh', () => {
    expect(gate({ event: 'push', now: TUE_0820, generatedAt: TUE_0820 - 60 })).toMatchObject({ run: '1', full: '0' });
    expect(gate({ event: 'workflow_dispatch', fullInput: true, now: TUE_0820, generatedAt: TUE_0820 - 60 })).toMatchObject({ run: '1', full: '1' });
  });

  it('is incremental for a plain dispatch, except on Sunday 00:00–00:59 UTC', () => {
    expect(gate({ event: 'workflow_dispatch', now: TUE_0820 }).full).toBe('0');
    expect(gate({ event: 'workflow_dispatch', now: SUN_0020 }).full).toBe('1');
    expect(gate({ event: 'workflow_dispatch', now: SUN_0020 + 3600 }).full).toBe('0');
    expect(gate({ event: 'schedule', schedule: SUNDAY, now: SUN_0020 }).full).toBe('1');
  });

  it("lets a late Saturday run not cancel the weekly full refresh, but skips Sunday's second trigger", () => {
    // Saturday's 20:20 slot ran at 23:30: still fresh at Sunday 00:20, yet no full refresh has run.
    expect(gate({ event: 'schedule', schedule: SUNDAY, now: SUN_0020, generatedAt: SUN_0020 - 50 * 60 })).toMatchObject({ run: '1', full: '1' });
    // The external dispatch already did Sunday's full refresh; GitHub's own schedule fires later.
    expect(gate({ event: 'schedule', schedule: SUNDAY, now: SUN_0020 + 5400, generatedAt: SUN_0020 + 300 }).run).toBe('0');
  });

});
