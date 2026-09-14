import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
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
    // Never inherit the switch, a manual fire, the factory credential, or the curl it would be
    // read with, from the ambient shell.
    FACTORY_ENABLED: '',
    FACTORY_FIRE: '',
    FACTORY_OPENROUTER_API_KEY: '',
    CURL_BIN: '',
    ...env,
  };
  // stderr is folded in: the launcher logs its fallback and rejection warnings there, and they
  // are part of the behaviour under test.
  const res = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: merged });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0) throw new Error(`tick exited ${res.status}: ${out}`);
  return out;
}

describe('the factory switch', () => {
  it('is off when nothing switches it on', () => {
    const out = tick({});
    expect(out).toContain('factory is off (not enabled');
    expect(out).not.toContain('nothing due');
  });

  it('runs when FACTORY_ENABLED=1 says so', () => {
    const out = tick({ FACTORY_ENABLED: '1' });
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

  it('lets any explicit off beat an explicit on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-envon-'));
    writeFileSync(join(dir, '.env'), 'FACTORY_ENABLED=0\n');
    const out = tick({ FACTORY_PROJECT_DIR: dir, FACTORY_ENABLED: '1' });
    expect(out).toContain('factory is off (FACTORY_ENABLED=0 in .env)');
  });

  it('reads the flag out of the repo .env rather than sourcing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-env-'));
    writeFileSync(join(dir, '.env'), '# factory\nFACTORY_ENABLED="off"   # why: holidays\nDISCORD_TOKEN=x\n');
    expect(tick({ FACTORY_PROJECT_DIR: dir })).toContain('factory is off (FACTORY_ENABLED=off in .env)');

    const on = mkdtempSync(join(tmpdir(), 'factory-envon-'));
    writeFileSync(join(on, '.env'), "FACTORY_ENABLED='1'  # the box opted in\n");
    expect(tick({ FACTORY_PROJECT_DIR: on })).toContain('nothing due');
  });

  it('stops on the pause file, and repeats its reason in the journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pause-'));
    const file = join(dir, 'PAUSED');
    writeFileSync(file, 'owner away until the 20th\n');
    const out = tick({ FACTORY_PAUSE_FILE: file, FACTORY_ENABLED: '1' });
    expect(out).toContain(`factory is off (${file}: owner away until the 20th)`);
    // The pause file is the reason, not the switch: removing it while nothing enables the
    // factory leaves it off, because absence means off.
    expect(tick({ FACTORY_PAUSE_FILE: join(dir, 'absent'), FACTORY_ENABLED: '1' })).toContain('nothing due');
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

// The factory key's `$5`-a-day cap is a dashboard fact, so the one thing that makes it safe is
// the preflight reading it live. These tests are about its polarity: a definite zero stops the
// tick, and everything else — including every way of failing to read the answer — does not.
describe("the factory key's budget preflight", () => {
  const KEY = 'sk-or-v1-factory-test';

  const callsFile = (curl: string) => join(dirname(curl), 'calls');
  const recordedCalls = (curl: string) =>
    existsSync(callsFile(curl)) ? readFileSync(callsFile(curl), 'utf8') : '';

  /** A stand-in for curl: records the arguments it was handed, then answers with `body` and the
   *  `\n<http_code>` trailer the launcher's `-w` asks for, or exits `exitCode` to stand in for a
   *  timeout or an unreachable host. */
  function fakeCurl(body: string, exitCode = 0, httpCode = 200): string {
    const dir = mkdtempSync(join(tmpdir(), 'factory-curl-'));
    const curl = join(dir, 'curl');
    const answer = exitCode === 0 ? `printf '%s\n%s' '${body}' '${httpCode}'` : `exit ${exitCode}`;
    writeFileSync(curl, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${join(dir, 'calls')}"\n${answer}\n`);
    chmodSync(curl, 0o755);
    return curl;
  }

  it('asks the key itself for its remaining budget, so a cap change needs no re-provision', () => {
    const curl = fakeCurl(JSON.stringify({ data: { limit: 5, limit_remaining: 4.83, limit_reset: 'daily' } }));
    tick({ FACTORY_ENABLED: '1', FACTORY_OPENROUTER_API_KEY: KEY, CURL_BIN: curl });

    const calls = recordedCalls(curl);
    expect(calls).toContain('https://openrouter.ai/api/v1/key');
    expect(calls).toContain(`Authorization: Bearer ${KEY}`);
  });

  it('skips the tick when the key is out of budget, and says why', () => {
    const curl = fakeCurl(JSON.stringify({ data: { limit: 5, limit_remaining: 0, limit_reset: 'daily' } }));
    const out = tick({ FACTORY_ENABLED: '1', FACTORY_OPENROUTER_API_KEY: KEY, CURL_BIN: curl });

    expect(out).toContain('factory key is out of budget (limit_remaining=0)');
    expect(out).not.toContain('nothing due');
  });

  it('runs the tick while budget is left, including a fractional remainder', () => {
    const curl = fakeCurl(JSON.stringify({ data: { limit: 5, limit_remaining: 0.42 } }));
    expect(tick({ FACTORY_ENABLED: '1', FACTORY_OPENROUTER_API_KEY: KEY, CURL_BIN: curl })).toContain('nothing due');
  });

  it('fails open: a timeout, an uncapped key or an unreadable body all let the tick run', () => {
    const timeout = fakeCurl('', 7);
    expect(tick({ FACTORY_ENABLED: '1', FACTORY_OPENROUTER_API_KEY: KEY, CURL_BIN: timeout })).toContain('nothing due');

    const uncapped = fakeCurl(JSON.stringify({ data: { limit: null, limit_remaining: null } }));
    expect(tick({ FACTORY_ENABLED: '1', FACTORY_OPENROUTER_API_KEY: KEY, CURL_BIN: uncapped })).toContain('nothing due');

    const garbage = fakeCurl('<html>rate limited</html>');
    expect(tick({ FACTORY_ENABLED: '1', FACTORY_OPENROUTER_API_KEY: KEY, CURL_BIN: garbage })).toContain('nothing due');
  });

  it('does not spend the request when there is nothing to guard', () => {
    // No factory key: this tick spends the shared credential, which the cap does not cover.
    const noKey = fakeCurl('{"data":{"limit_remaining":0}}');
    expect(tick({ FACTORY_ENABLED: '1', CURL_BIN: noKey })).toContain('nothing due');
    expect(existsSync(callsFile(noKey))).toBe(false);

    // Factory off: the switch is decided first, and a stopped factory spends nothing at all.
    const off = fakeCurl('{"data":{"limit_remaining":0}}');
    expect(tick({ FACTORY_OPENROUTER_API_KEY: KEY, CURL_BIN: off })).toContain('factory is off');
    expect(existsSync(callsFile(off))).toBe(false);
  });

  it('guards a box that keeps the key in .env and never exports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-keyenv-'));
    writeFileSync(join(dir, '.env'), `FACTORY_ENABLED=1\nFACTORY_OPENROUTER_API_KEY=${KEY}\n`);
    const curl = fakeCurl(JSON.stringify({ data: { limit_remaining: 0 } }));

    const out = tick({ FACTORY_PROJECT_DIR: dir, CURL_BIN: curl });
    expect(out).toContain('out of budget');
    expect(recordedCalls(curl)).toContain(`Authorization: Bearer ${KEY}`);
  });

  it('skips the tick when OpenRouter rejects the key itself, not only when it is spent', () => {
    const rejected = fakeCurl(JSON.stringify({ error: { message: 'User not found.', code: 401 } }), 0, 401);
    const out = tick({ FACTORY_ENABLED: '1', FACTORY_OPENROUTER_API_KEY: KEY, CURL_BIN: rejected });

    expect(out).toContain('rejected by OpenRouter (HTTP 401)');
    expect(out).not.toContain('nothing due');
  });

  it('keeps failing open on a server-side answer it cannot act on', () => {
    const boom = fakeCurl('"internal error"', 0, 500);
    expect(tick({ FACTORY_ENABLED: '1', FACTORY_OPENROUTER_API_KEY: KEY, CURL_BIN: boom })).toContain('nothing due');
  });
});

// The fire is the one argv this repo assembles in shell, so unlike `stagePiArgs` it has no type
// checking it. The pin is load-bearing: with no `--model`, pi resolves the model from settings
// and installs `--api-key` against THAT provider, so the OpenRouter key would land somewhere
// else entirely and every fire would 401. These pin the argv itself, not the log line.
describe("the schedule fire's argv", () => {
  const KEY = 'sk-or-v1-factory-test';
  const MODEL = 'openrouter/deepseek/deepseek-v4.1-flash';

  /** A stand-in for pi that records the argv it was handed. */
  function fakePi(): { bin: string; argv: () => string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'factory-pi-'));
    const bin = join(dir, 'pi');
    const recorded = join(dir, 'argv');
    writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> '${recorded}'\n`);
    chmodSync(bin, 0o755);
    return {
      bin,
      argv: () => (existsSync(recorded) ? readFileSync(recorded, 'utf8').split('\n').filter(Boolean) : []),
    };
  }

  it('pins the model ahead of the key, so --api-key is installed against the OpenRouter provider', () => {
    const pi = fakePi();
    // A named fire while the factory is off: it goes through the same preflight, so it needs a
    // curl that answers, and it stops before the drain.
    const dir = mkdtempSync(join(tmpdir(), 'factory-pi-curl-'));
    const curl = join(dir, 'curl');
    writeFileSync(curl, `#!/usr/bin/env bash\nprintf '%s\\n%s' '${JSON.stringify({ data: { limit_remaining: 5 } })}' '200'\n`);
    chmodSync(curl, 0o755);
    tick({ FACTORY_ENABLED: '0', FACTORY_FIRE: 'factory-triage', FACTORY_OPENROUTER_API_KEY: KEY, PI_BIN: pi.bin, CURL_BIN: curl });

    const argv = pi.argv();
    expect(argv.slice(0, 8)).toEqual(['-p', '--approve', '--tools', 'subagent', '--model', MODEL, '--api-key', KEY]);
    expect(argv[8]).toContain('schedule.run');
  });

  it('keeps the pin on the shared-credential fallback, and omits --api-key rather than passing it empty', () => {
    const pi = fakePi();
    const out = tick({ FACTORY_ENABLED: '0', FACTORY_FIRE: 'factory-triage', PI_BIN: pi.bin });

    const argv = pi.argv();
    expect(argv[argv.indexOf('--model') + 1]).toBe(MODEL);
    expect(argv).not.toContain('--api-key');
    expect(out).toContain('no FACTORY_OPENROUTER_API_KEY');
  });
});
