#!/usr/bin/env node
/**
 * The protocol-log replay runner — `npm run agent:replay -- <protocol.json> [--stub|--real]`. The clock pins to the
 * header's `recordedAt` and steps a day per tick marker, so a multi-day recording is byte-green only where the host's local weekday matches (the committed corpus is mid-week, a weekday at every offset).
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { CannedStubBackend, configureCannedScript } from './stub.js';
import { deterministicPipelineScript, buildDeterministicRouter } from './deterministicSession.js';
import { buildAgentEngine } from './engineHarness.js';
import { PipelineScriptedGateway } from '../sim/PipelineScriptedGateway.js';
import { GameRouter } from '../protocol/router.js';
import { pinAdvancingClock } from './clock.js';
import type { AdvancingClock } from './clock.js';
import { establishBootParity } from './bootParity.js';
import { PROTOCOL_VERSION, validateGameResponse, type GameResponse } from '../protocol/envelope.js';
import { validateGameEvent, type GameEvent } from '../protocol/events.js';
import { decisionLegalMoves, isLegal, menuLegalMoves } from './agentMoves.js';
import type { ProtocolDispatchEntry, ProtocolEntry, ProtocolHeaderEntry } from './transcript.js';
import type { ViewState } from '../view/viewState.js';
import type { AgentMove } from './AgentPlayerGateway.js';
import type { WorldEngineImpl } from '../engine/WorldEngineImpl.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ── Deep equality + diff: a real recursive structural comparison, not a JSON.stringify ──

// Both sides are compared in their JSON FORM: the recorded log IS JSON by construction, and the live
// envelope is normalized through a JSON round trip before comparing.

// The one loss is JSON's: undefined-valued optional view fields drop — a field present-with-undefined on
// the live object and absent in the recorded JSON carries zero information (the contract suite agrees).

// The comparison is structural and order-independent over the JSON forms: two envelopes are equal here
// iff their JSON forms deep-equal, and equal envelopes can stringify to different bytes (key order is irrelevant, pinned by a test).

/** Deep-compare two plain-JSON values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    // The guard above proved both are non-null objects of the same typeof — the cast is safe.
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const ka = Object.keys(ra);
    const kb = Object.keys(rb);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(rb, k) && deepEqual(ra[k], rb[k]));
  }
  return false;
}

/** Cheap recursive diff — which field(s) differ between two JSON-form values (path-annotated
 *  lines like `response.view.text: "a" !== "b"`), for the mismatch report. */
function diffObjects(a: unknown, b: unknown, path: string, out: string[]): void {
  if (deepEqual(a, b)) return;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    out.push(`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}: array length ${a.length} !== ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) diffObjects(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    if (!(k in ra)) { out.push(`${path}.${k}: missing in live`); continue; }
    if (!(k in rb)) { out.push(`${path}.${k}: missing in recorded`); continue; }
    diffObjects(ra[k], rb[k], `${path}.${k}`, out);
  }
}

// ── File structural validation: malformed/missing → validation failure, never a silent skip ──

// Shape-level only: event/response DEEP validation runs per entry in the replay loop, so one bad entry is
// a per-entry failure and the loop still replays the rest of the stream to complete the report.

function validateProtocolFile(raw: unknown): { ok: true; entries: ProtocolEntry[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'protocol log must be a JSON array' };
  if (raw.length === 0) return { ok: false, message: 'protocol log is empty — no header entry' };

  const [head, ...rest] = raw;
  if (!isRecord(head) || head.kind !== 'header') {
    return { ok: false, message: 'entry 0 must be the header entry { kind: "header", v, userId, brain, backend }' };
  }
  // The header's seq is pinned to 0 — a header claiming a later seq (e.g. `seq: 99`) would
  // otherwise replay exit-0 while being silently rebuilt as 0 here.
  if (head.seq !== 0) {
    return { ok: false, message: 'header entry: seq must be 0' };
  }
  if (head.v !== PROTOCOL_VERSION) {
    return { ok: false, message: `header.v must equal PROTOCOL_VERSION (${PROTOCOL_VERSION}); got ${JSON.stringify(head.v)}` };
  }
  if (typeof head.userId !== 'string' || head.userId.length === 0) {
    return { ok: false, message: 'header.userId must be a non-empty string' };
  }
  if (head.brain !== 'scripted' && head.brain !== 'prod') {
    return { ok: false, message: "header.brain must be 'scripted' | 'prod'" };
  }
  if (head.backend !== 'real' && head.backend !== 'stub') {
    return { ok: false, message: "header.backend must be 'real' | 'stub'" };
  }
  // Required, and required to PARSE — a header carrying an unparseable stamp would otherwise pin the
  // clock to Invalid Date and turn every weekday branch into a silent NaN comparison.
  if (typeof head.recordedAt !== 'string' || Number.isNaN(new Date(head.recordedAt).getTime())) {
    return { ok: false, message: 'header.recordedAt must be an ISO-8601 timestamp (DC-M10.6)' };
  }
  // Optional: a pre-persona recording carries no key at all, so absence is legal — a present-but-non-string
  // key is malformed and would otherwise be silently dropped here.
  if (head.persona !== undefined && typeof head.persona !== 'string') {
    return { ok: false, message: 'header.persona must be a string when present' };
  }

  const header: ProtocolHeaderEntry = {
    seq: 0,
    kind: 'header',
    v: head.v,
    userId: head.userId,
    brain: head.brain,
    backend: head.backend,
    recordedAt: head.recordedAt,
    ...(typeof head.persona === 'string' ? { persona: head.persona } : {}),
  };
  const entries: ProtocolEntry[] = [header];
  let seq = 1;
  let sawDispatch = false;
  for (const entry of rest) {
    if (!isRecord(entry)) return { ok: false, message: `entry ${seq}: must be a plain object` };
    if (entry.seq !== seq) return { ok: false, message: `entry ${seq}: seq must be ${seq} (got ${JSON.stringify(entry.seq)})` };
    if (entry.kind === 'dispatch') {
      sawDispatch = true;
      if (!isRecord(entry.event) || typeof entry.event.type !== 'string') {
        return { ok: false, message: `entry ${seq}: dispatch must carry event: { type: string, ... }` };
      }
      if (!isRecord(entry.response) || entry.response.v !== PROTOCOL_VERSION || typeof entry.response.ok !== 'boolean') {
        return { ok: false, message: `entry ${seq}: dispatch must carry response: { v, ok, ... }` };
      }
      if (entry.beats !== undefined && !Array.isArray(entry.beats)) {
        return { ok: false, message: `entry ${seq}: beats must be an array when present` };
      }
      entries.push({
        seq,
        kind: 'dispatch',
        event: entry.event as GameEvent,
        response: entry.response as GameResponse,
        ...(Array.isArray(entry.beats) ? { beats: entry.beats as GameResponse[] } : {}),
      });
    } else if (entry.kind === 'tick') {
      // Tick markers only follow a day's dispatches: a tick-led stream is structurally malformed, or the
      // first-dispatch invariant below would be evadable by a leading tick marker.
      if (!sawDispatch) {
        return { ok: false, message: `tick entry ${seq}: tick marker precedes the first dispatch` };
      }
      if (!Number.isInteger(entry.dayNumber)) {
        return { ok: false, message: `entry ${seq}: tick must carry an integer dayNumber` };
      }
      entries.push({ seq, kind: 'tick', dayNumber: entry.dayNumber as number });
    } else {
      return { ok: false, message: `entry ${seq}: kind must be 'dispatch' | 'tick' (got ${JSON.stringify(entry.kind)})` };
    }
    seq++;
  }
  return { ok: true, entries };
}

export interface ReplayOptions {
  /** Override the header's recorded backend class (the CLI's --stub/--real). */
  backend?: 'real' | 'stub';
}

export interface ReplayEntryResult {
  seq: number;
  kind: 'dispatch' | 'tick';
  /** True when the entry validated AND matched. */
  ok: boolean;
  /** The event type, for dispatch entries. */
  eventType?: string;
  /** Diff summary lines when a final/beat envelope didn't match the recorded one. */
  diff?: string[];
  /** A validation failure message (event invalid, sequence-sanity breach). */
  validationError?: string;
}

export interface ReplayResult {
  /** True only when every entry validated AND matched. */
  ok: boolean;
  /** A fatal structural failure — the file isn't replayable (nothing was replayed). */
  fatal?: string;
  /** The backend class the replay actually ran against. */
  backend: 'real' | 'stub';
  header?: ProtocolHeaderEntry;
  /** Non-fatal warnings (e.g. a --stub/--real flag overriding the recorded header class). */
  warnings: string[];
  /** One result per non-header entry, in stream order. */
  entries: ReplayEntryResult[];
}

/** Replay an in-process protocol log (the CLI's engine; tests drive this directly). The log is consumed
 *  in its JSON form, so a live transcript object and its recorded twin compare equal. */

export async function replayLog(protocol: ProtocolEntry[], opts: ReplayOptions = {}): Promise<ReplayResult> {
  // Pin before anything runs, restore unconditionally. The pin ADVANCES one day per tick marker: the
  // recording half stepped a day per nightly tick, so only a stepping replay re-ticks on the right date.

  // A malformed or absent stamp replays unpinned rather than throwing — `validateProtocolFile` already
  // rejects those, so this only forgives a hand-built in-process log, and the header is normalized below.
  const head = protocol[0];
  const stamp = head?.kind === 'header' ? head.recordedAt : undefined;
  const clock = typeof stamp === 'string' && !Number.isNaN(new Date(stamp).getTime())
    ? pinAdvancingClock(stamp)
    : undefined;
  try {
    return await replayLogPinned(protocol, opts, clock);
  } finally {
    clock?.restore();
  }
}

async function replayLogPinned(
  protocol: ProtocolEntry[],
  opts: ReplayOptions = {},
  clock?: AdvancingClock,
): Promise<ReplayResult> {
  const header = protocol[0];
  if (!header || header.kind !== 'header') {
    return {
      ok: false,
      fatal: 'entry 0 is not the header entry — malformed protocol log',
      backend: opts.backend ?? 'stub',
      warnings: [],
      entries: [],
    };
  }

  // The JSON-form contract (see the JSDoc): normalize before any comparison. A no-op for JSON callers
  // (the CLI, file-loaded logs) — live transcript objects gain the same form.
  protocol = JSON.parse(JSON.stringify(protocol)) as ProtocolEntry[];

  const backend = opts.backend ?? header.backend;
  const warnings: string[] = [];
  if (opts.backend && opts.backend !== header.backend) {
    warnings.push(`header records backend '${header.backend}' but the run forces '${opts.backend}' (flag override)`);
  }

  const firstDispatch = protocol.find((e): e is ProtocolDispatchEntry => e.kind === 'dispatch');

  let router: GameRouter;
  let engine: WorldEngineImpl | undefined;
  if (backend === 'real') {
    // Re-seeding happens by REPLAYING the recorded creation walk on the fresh engine. A stream without
    // the walk (an inherit-class transcript) cannot re-seed itself — error out; the caller must pre-seed.
    if (!firstDispatch || firstDispatch.event.type !== 'join.open') {
      return {
        ok: false,
        fatal:
          'real-backend replay requires the recorded creation walk (the stream must begin with join.open) ' +
          'to re-seed the character — this transcript has none (an inherit-class transcript); ' +
          'the caller must pre-seed the engine instead (DC-S2)',
        backend,
        header,
        warnings,
        entries: [],
      };
    }
    const agentEngine = buildAgentEngine({
      pipelineLlmGateway: new PipelineScriptedGateway(deterministicPipelineScript),
      rollD20: () => 20,
    });
    establishBootParity(agentEngine.db);
    engine = agentEngine.engine;
    router = buildDeterministicRouter(agentEngine);
  } else {
    const stub = new CannedStubBackend();
    configureCannedScript(stub);
    router = new GameRouter(stub, { idle: () => '' });
  }

  const entries: ReplayEntryResult[] = [];

  // Stream state. `lastView` is the preceding recorded envelope's view (the artifact invariant reads the
  // RECORDED stream); `walkActive` tracks the leading creation-walk prefix.
  let lastView: ViewState | undefined;
  let walkActive = firstDispatch?.event.type === 'join.open';
  // Dispatch-only counter for the first-dispatch invariant: tick markers are not dispatches, so a
  // tick-led in-process stream's first dispatch cannot dodge the check.
  let dispatchCount = 0;

  for (const entry of protocol) {
    if (entry.kind === 'header') continue;

    if (entry.kind === 'tick') {
      // One calendar day per tick marker: the recording half stepped the clock inside `endDay` before
      // each `tick(true)`, so the replay must step identically or the re-ticks land on wrong weekdays.

      // The step sits AHEAD of both arms for symmetry: the canned stub observer owns no world, so it is
      // inert there, but the clock state a stream implies should not depend on which backend read it.
      clock?.advanceDays(1);
      if (backend === 'real' && engine) {
        const tick = engine.tick(true);
        const ok = tick.dayNumber === entry.dayNumber;
        entries.push({
          seq: entry.seq,
          kind: 'tick',
          ok,
          ...(ok ? {} : { diff: [`tick dayNumber ${tick.dayNumber} !== recorded ${entry.dayNumber}`] }),
        });
      } else {
        // Stub replay: the stub has no world to tick — the marker validated structurally is all it asserts.
        entries.push({ seq: entry.seq, kind: 'tick', ok: true });
      }
      continue;
    }

    const event = entry.event;
    const type = event.type;

    // Every event validates FIRST, so the sequence-sanity block below may deref the validated event's
    // fields unguarded: an action.choose without a selector is a validation failure, never a TypeError.
    const ev = validateGameEvent(event);

    // ── Sequence sanity: the scripted beats hi.open / screen.stats / screen.look AND a brain-chosen
    // recon `screen.*` dispatch are chrome, with no preceding-view check. ──
    const sanityFailures: string[] = [];

    // wizard.* events only appear inside the creation walk prefix. The prefix starts at the stream's
    // join.open and ends at character.create (the confirm) or the first non-walk dispatch.
    if (type === 'character.create') {
      walkActive = false;
    } else if (type.startsWith('wizard.')) {
      if (!walkActive) sanityFailures.push(`${type} outside the creation walk prefix`);
    } else if (type !== 'join.open') {
      walkActive = false;
    }

    // The first dispatch must be the creation walk's join.open, hi.open (inherit/beats) or menu.open
    // (mid-session) — counted in dispatches only, so a leading tick marker cannot swallow the check.
    if (dispatchCount === 0) {
      if (type !== 'join.open' && type !== 'hi.open' && type !== 'menu.open') {
        sanityFailures.push(`first dispatch is ${type} — must be join.open (creation walk), hi.open (inherit) or menu.open (mid-session)`);
      }
    }
    dispatchCount++;

    // The two preceding-view legality rules — shape-dependent, so they only run on a validated event
    // (the shape guarantees selector/jobIndex exist).
    if (ev.ok && type === 'action.choose') {
      const view = lastView;
      if (!view || view.screen !== 'decision') {
        sanityFailures.push('action.choose without a preceding decision view');
      } else {
        const move: AgentMove = event.selector.kind === 'bail' ? { kind: 'bail' } : { kind: 'choice', index: event.selector.index };
        if (!isLegal(move, decisionLegalMoves(view))) {
          sanityFailures.push(`action.choose selector ${JSON.stringify(event.selector)} not within the preceding decision view's buttons`);
        }
      }
    } else if (ev.ok && type === 'dayjob.start') {
      const view = lastView;
      if (!view || view.screen !== 'menu') {
        sanityFailures.push('dayjob.start without a preceding menu view');
      } else if (!isLegal({ kind: 'menu-pick', index: event.jobIndex }, menuLegalMoves(view))) {
        sanityFailures.push(`dayjob.start jobIndex ${event.jobIndex} not within the preceding menu view's buttons`);
      }
    }

    let validationError: string | undefined;
    if (sanityFailures.length) validationError = sanityFailures.join('; ');
    if (!ev.ok) {
      validationError = validationError ? `${validationError}; event invalid: ${ev.message}` : `event invalid: ${ev.message}`;
    }

    if (validationError) {
      entries.push({ seq: entry.seq, kind: 'dispatch', eventType: type, ok: false, validationError });
      // The recorded envelope is still the authoritative stream state for the invariant.
      if (entry.response.ok && entry.response.view) lastView = entry.response.view;
      continue;
    }

    // ── Dispatch + assert. Beats are collected only when the recording carries them: a recording
    // without beats never asserted them, and beats are advisory chrome. ──
    const recordedBeats = entry.beats;
    const liveBeats: GameResponse[] = [];
    const response = await router.dispatch(
      event,
      recordedBeats
        ? (beat) => {
            liveBeats.push(beat);
          }
        : undefined,
    );

    const diffs: string[] = [];

    const vr = validateGameResponse(response);
    if (!vr.ok) {
      diffs.push(`live response failed its own validator: ${vr.message}`);
    } else {
      // Both sides in their JSON form (see the deep-equal note above).
      const liveJson = JSON.parse(JSON.stringify(response)) as unknown;
      if (!deepEqual(liveJson, entry.response)) {
        diffObjects(liveJson, entry.response, 'response', diffs);
      }
    }

    if (recordedBeats) {
      for (const beat of liveBeats) {
        const vb = validateGameResponse(beat);
        if (!vb.ok) diffs.push(`live beat failed its own validator: ${vb.message}`);
      }
      const beatsJson = JSON.parse(JSON.stringify(liveBeats)) as unknown;
      if (!deepEqual(beatsJson, recordedBeats)) {
        diffObjects(beatsJson, recordedBeats, 'beats', diffs);
      }
    }

    entries.push({
      seq: entry.seq,
      kind: 'dispatch',
      eventType: type,
      ok: diffs.length === 0,
      ...(diffs.length ? { diff: diffs } : {}),
    });

    // The recorded envelope is the invariant's authoritative view source.
    if (entry.response.ok && entry.response.view) lastView = entry.response.view;
  }

  return { ok: entries.every((e) => e.ok), backend, header, warnings, entries };
}

/** Load + validate + replay a protocol file (the CLI's engine; the in-process tests can also
 *  drive it to exercise the file-shaped validation path). */
export function replayFile(filePath: string, opts: ReplayOptions = {}): Promise<ReplayResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return Promise.resolve({
      ok: false,
      fatal: `cannot read/parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      backend: opts.backend ?? 'stub',
      warnings: [],
      entries: [],
    });
  }
  const check = validateProtocolFile(raw);
  if (!check.ok) {
    return Promise.resolve({
      ok: false,
      fatal: check.message,
      backend: opts.backend ?? 'stub',
      warnings: [],
      entries: [],
    });
  }
  return replayLog(check.entries, opts);
}

// ── CLI (a thin shell over replayFile; the in-process tests drive replayLog/replayFile) ──

function parseArgs(argv: string[]): { file?: string; backend?: 'real' | 'stub'; error?: string } {
  let file: string | undefined;
  let backend: 'real' | 'stub' | undefined;
  for (const arg of argv) {
    if (arg === '--stub' || arg === '--real') {
      if (backend && backend !== arg.slice(2)) return { error: 'both --stub and --real given' };
      backend = arg.slice(2) as 'real' | 'stub';
    } else if (arg.startsWith('-')) {
      return { error: `unknown flag "${arg}"` };
    } else if (file === undefined) {
      file = arg;
    } else {
      return { error: `unexpected argument "${arg}"` };
    }
  }
  return { file, backend };
}

async function main(): Promise<void> {
  const { file, backend, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(`agent:replay: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (!file) {
    console.error('agent:replay: usage: npm run agent:replay -- <protocol.json> [--stub|--real]');
    process.exitCode = 1;
    return;
  }

  const result = await replayFile(file, { backend });

  console.error(`agent:replay: ${file}`);
  if (result.header) {
    console.error(`  header: v=${result.header.v} userId=${result.header.userId} brain=${result.header.brain} recorded backend=${result.header.backend}`);
  }
  if (result.fatal) {
    console.error(`  FATAL — ${result.fatal}`);
    process.exitCode = 1;
    return;
  }
  for (const w of result.warnings) console.error(`  warning: ${w}`);
  console.error(
    `  backend: ${result.backend} — ${
      result.backend === 'real'
        ? 'fresh deterministic engine, re-seeded by replaying the recorded creation walk'
        : 'fresh canned StubBackend + configureCannedScript'
    }`,
  );

  let mismatches = 0;
  let invalid = 0;
  for (const e of result.entries) {
    if (e.ok) continue;
    if (e.kind === 'tick') {
      mismatches++;
      console.error(`  seq ${e.seq} (tick): MISMATCH — ${e.diff?.[0] ?? 'dayNumber mismatch'}`);
      continue;
    }
    if (e.validationError) {
      invalid++;
      console.error(`  seq ${e.seq} (${e.eventType}): INVALID — ${e.validationError}`);
    } else {
      mismatches++;
      console.error(`  seq ${e.seq} (${e.eventType}): MISMATCH`);
    }
    for (const d of e.diff ?? []) console.error(`    ${d}`);
  }

  let dispatchCount = 0;
  let tickCount = 0;
  let okCount = 0;
  for (const e of result.entries) {
    if (e.kind === 'dispatch') dispatchCount++;
    else tickCount++;
    if (e.ok) okCount++;
  }
  console.error(
    `  ${dispatchCount} dispatch(es) + ${tickCount} tick marker(s); ${okCount} passed, ${mismatches} mismatch(es), ${invalid} validation failure(s)`,
  );
  if (result.ok) {
    console.error('  ✓ every entry validated and matched — replay byte-green');
  } else {
    console.error('  ✗ replay failed — see the entries above');
  }
  process.exitCode = result.ok ? 0 : 1;
}

// Run only when executed directly (npm run agent:replay) — importing the module in-process (the replay
// tests, future corpus recorders) must not trigger the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
