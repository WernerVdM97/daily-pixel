import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The launcher, run for real but against a scratch project dir: no schedules exist there, and
// scripts/factory-jobs.ts is absent, so the drain and pruner steps are skipped by their own
// guards. `PI_BIN=/bin/true` keeps the schedules step harmless on a machine with no pi, and on
// CI. What is under test is the switch, not the factory: a tick that runs schedules here would
// mean the switch failed to stop it.
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/factory-run-due.sh');
const REPO_ROOT = resolve(dirname(SCRIPT), '..');

function tick(env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-tick-'));
  const merged: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FACTORY_PROJECT_DIR: dir,
    FACTORY_PAUSE_FILE: join(dir, 'PAUSED'),
    FACTORY_LOCK_FILE: join(dir, 'lock'),
    FACTORY_MIN_AVAIL_MB: '1',
    PI_BIN: '/bin/true',
    // Never inherit the switch or a manual fire from the ambient shell.
    FACTORY_ENABLED: '',
    FACTORY_FIRE: '',
    ...env,
  };
  try {
    return execFileSync('bash', [SCRIPT], { encoding: 'utf8', env: merged });
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    throw new Error(`tick exited ${failure.status}: ${failure.stdout ?? ''}${failure.stderr ?? ''}`);
  }
}

describe('the factory switch', () => {
  it('runs normally when nothing switches it off', () => {
    const out = tick({});
    expect(out).toContain('nothing due');
    expect(out).not.toContain('factory is off');
  });

  it('stops the whole tick for FACTORY_ENABLED=0', () => {
    const out = tick({ FACTORY_ENABLED: '0' });
    expect(out).toContain('factory is off (FACTORY_ENABLED=0)');
    expect(out).not.toContain('nothing due');
    expect(out).not.toContain('draining job stages');
  });

  it('accepts the spellings an operator actually types', () => {
    for (const value of ['false', 'FALSE', 'no', 'off']) {
      expect(tick({ FACTORY_ENABLED: value })).toContain('factory is off');
    }
    for (const value of ['1', 'true', 'yes', 'on']) {
      expect(tick({ FACTORY_ENABLED: value })).toContain('nothing due');
    }
  });

  it('reads the flag out of the repo .env rather than sourcing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-env-'));
    writeFileSync(join(dir, '.env'), '# factory\nFACTORY_ENABLED="off"   # why: holidays\nDISCORD_TOKEN=x\n');
    const out = tick({ FACTORY_PROJECT_DIR: dir });
    expect(out).toContain('factory is off (FACTORY_ENABLED=off in .env)');
  });

  it('stops on the pause file, and repeats its reason in the journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pause-'));
    const file = join(dir, 'PAUSED');
    writeFileSync(file, 'owner away until the 20th\n');
    const out = tick({ FACTORY_PAUSE_FILE: file });
    expect(out).toContain(`factory is off (${file}: owner away until the 20th)`);
    expect(tick({ FACTORY_PAUSE_FILE: join(dir, 'absent') })).toContain('nothing due');
  });

  it('ships off in the example, so a box provisioned from it is opt-in', () => {
    expect(readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8')).toMatch(/^FACTORY_ENABLED=0$/m);
  });

  it('still fires a schedule named by hand, and stops before the drain', () => {
    const out = tick({ FACTORY_ENABLED: '0', FACTORY_FIRE: 'factory-triage' });
    expect(out).toContain('firing factory-triage anyway');
    expect(out).toContain('the drain and housekeeping steps are skipped too');
    expect(out).not.toContain('draining job stages');
  });
});
