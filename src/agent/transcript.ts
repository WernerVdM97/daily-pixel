/**
 * The agent-player run transcript (JSON-seam M4.2). A flat, append-only log of what the agent saw
 * and did — the QA/playtest artefact both goals build on: M4.4 turns exceptions/dead-ends into
 * `finding` events, M4.5 feeds the whole log to the critic. Deliberately plain data (no engine or
 * discord types) so it serialises straight to JSON for a repro.
 *
 * M8.5 (DC-S1): the transcript ALSO carries a parallel `protocol` log — one raw
 * `{ seq, event, response, beats? }` entry per dispatch plus a header and nightly-tick markers,
 * making a run replayable and diffable across builds. The protocol types (GameEvent/GameResponse)
 * are plain JSON data by construction, so they keep the transcript's serialise-straight-to-JSON
 * property. The agent → protocol import direction is intended (harness.ts already does it).
 */

import { PROTOCOL_VERSION, type GameResponse } from '../protocol/envelope.js';
import type { GameEvent } from '../protocol/events.js';
import type { AgentMove, LegalMove, Recurrence, ReconScreen } from './AgentPlayerGateway.js';

/** One turn: the screen the brain read, the moves offered, and the move it committed to. */
export interface TurnEvent {
  type: 'turn';
  /** 'menu' | 'decision' — which screen kind the brain was answering. */
  screen: 'menu' | 'decision';
  /** The rendered screen text (`viewToText`). */
  text: string;
  /** Labels of the moves offered, in the order the brain saw them. */
  offered: string[];
  /** The move the brain returned. */
  chosen: AgentMove;
}

/** A terminal or noteworthy event closing out an action or a day. */
export interface OutcomeEvent {
  type: 'outcome';
  text: string;
  /** The action model's own label for the action that produced this outcome — the outcome
   *  envelope's `facts.distilledType` (a `FACTS_KEYS` fact), recorded verbatim. MODEL-AUTHORED and
   *  open-vocabulary, NOT the engine's classify kind (which is not on the envelope) and not a
   *  persona's verb priors (contract §9, the correction found while implementing T5). Never
   *  keyword-matched from the outcome text. Absent on an envelope that carried no fact. */
  verb?: string;
}
export interface DeadEndEvent { type: 'dead-end'; reason: string; detail?: string }
export interface DayBoundaryEvent { type: 'day'; dayNumber: number; note: string }
/** The day-job work flow's transient commute beat (the "you moved to work" screen) — an
 *  informational beat the acting player sees between picking the job and its outcome. */
export interface CommuteEvent { type: 'commute'; destination: string; text: string }
/** A QA finding (M4.4). `error` = an invariant breach or an uncaught exception; `warning` = a
 *  soft anomaly (a stall, an illegal move, a capped loop) that didn't corrupt state. */
export interface FindingEvent { type: 'finding'; severity: 'error' | 'warning'; summary: string; detail?: string }
/** A scripted day-start greeting (DC-S3, type plumbing only at M8.5 task 1) — the screen text of
 *  the `hi.open` parity beat. Pure derived data, never wired into the play loop here (task 4). */
export interface GreetingEvent { type: 'greeting'; text: string }
/** A recon screen the brain asked to read (spec § C) — free, deterministic, and re-readable here
 *  for the critic, which is why the whole rendered text is kept and not just the screen name. */
export interface ReconEvent { type: 'recon'; screen: ReconScreen; text: string }
/** A friction the brain reported this turn (spec § E). The recurrence tag is what a raw count
 *  cannot express: in a daily ritual a screen read every day costs more than a once-a-session
 *  clunk, so the panel ranks by projected exposure rather than by how often it happens to appear. */
export interface FrictionEvent {
  type: 'friction';
  dayNumber: number;
  what: string;
  severity: number;
  recurrence: Recurrence;
}
/** The day's note (spec § E): the rating pair, one line on the day, and the arc note as it stood at
 *  the end of it. Written when the day closes, whatever closed it — the note may ride any turn, and
 *  the last one the brain reported is the one that counts. */
export interface DayNoteEvent {
  type: 'day-note';
  dayNumber: number;
  engagement: number;
  fulfilment: number;
  line: string;
  arcNote: string;
}

export type TranscriptEvent =
  | TurnEvent
  | OutcomeEvent
  | DeadEndEvent
  | DayBoundaryEvent
  | CommuteEvent
  | FindingEvent
  | GreetingEvent
  | ReconEvent
  | FrictionEvent
  | DayNoteEvent;

// ── The parallel protocol log (DC-S1) — plain JSON entries, no timestamps (determinism). ──

/** The header entry (seq 0): the protocol version + session identity so a replay knows which
 *  backend class to use (`backend`) and how to interpret a mismatch (`brain`). */
export interface ProtocolHeaderEntry {
  seq: 0;
  kind: 'header';
  v: number;
  userId: string;
  brain: 'scripted' | 'prod';
  backend: 'real' | 'stub';
  /** The wall clock the session was recorded against, ISO-8601 (DC-M10.6). Replay pins the
   *  process clock to it, which is what removes the SF3 same-weekday-class caveat: the
   *  day-start greeting reads `isWeekend()` and the tick reads `getUTCDay() === 6`, so a
   *  transcript recorded on a Thursday used to diverge when replayed on a Saturday. Supplied
   *  by the caller rather than read here, so this module stays env- and clock-free (DC-S1). */
  recordedAt: string;
  /** The persona the run played as (spec § H), stamped alongside `brain`/`backend` so a recorded
   *  run is attributable in replay. Absent on a persona-less run — which is what keeps every
   *  pre-persona recording byte-identical. */
  persona?: string;
}

/** One raw dispatch: the exact `GameEvent` sent and the final `GameResponse` envelope returned,
 *  plus the interstitial beats (`loading`/`commute`/thinking) when recorded (the `recordBeats`
 *  knob — default off; beats are advisory transport chrome, the final envelope is the contract). */
export interface ProtocolDispatchEntry {
  seq: number;
  kind: 'dispatch';
  event: GameEvent;
  response: GameResponse;
  beats?: GameResponse[];
}

/** The engine-direct nightly world-cron marker, recorded so a real-backend replay can re-execute
 *  ticks at the right points and keep day-number-seeded RNG aligned. */
export interface ProtocolTickEntry {
  seq: number;
  kind: 'tick';
  dayNumber: number;
}

export type ProtocolEntry = ProtocolHeaderEntry | ProtocolDispatchEntry | ProtocolTickEntry;

/** A run-level roll-up over the transcript — the QA scoreboard `play.ts` prints and M4.5's critic
 *  reads first for orientation. Pure derived data (recomputed from `events`), never a second source
 *  of truth. */
export interface TranscriptSummary {
  turns: number;
  outcomes: number;
  deadEnds: number;
  commutes: number;
  /** Day boundaries crossed (nightly ticks) — one fewer than days touched. */
  dayBoundaries: number;
  /** Scripted day-start greetings (DC-S3). */
  greetings: number;
  /** Recon screens the brain asked to read (spec § C). */
  recons: number;
  /** Frictions the brain reported (spec § E). */
  frictions: number;
  findings: { error: number; warning: number };
}

/** A minimal append-only sink. A class (not a bare array) so later slices can add derived
 *  summaries (finding counts, day tallies) without changing every call site. */
export class Transcript {
  readonly events: TranscriptEvent[] = [];

  /** The parallel protocol log (DC-S1) — one entry per dispatch plus the header and nightly-tick
   *  markers, recorded at the single `dispatch()` point inside the harness. */
  readonly protocol: ProtocolEntry[] = [];

  /** Dispatch/tick sequence numbers — start at 1 (0 is reserved for the header). */
  private seq = 1;

  turn(screen: 'menu' | 'decision', text: string, offered: LegalMove[], chosen: AgentMove): void {
    this.events.push({ type: 'turn', screen, text, offered: offered.map((m) => m.label), chosen });
  }

  outcome(text: string, verb?: string): void {
    this.events.push({ type: 'outcome', text, ...(verb ? { verb } : {}) });
  }

  deadEnd(reason: string, detail?: string): void {
    this.events.push({ type: 'dead-end', reason, ...(detail ? { detail } : {}) });
  }

  day(dayNumber: number, note: string): void {
    this.events.push({ type: 'day', dayNumber, note });
  }

  commute(destination: string, text: string): void {
    this.events.push({ type: 'commute', destination, text });
  }

  finding(severity: 'error' | 'warning', summary: string, detail?: string): void {
    this.events.push({ type: 'finding', severity, summary, ...(detail ? { detail } : {}) });
  }

  greeting(text: string): void {
    this.events.push({ type: 'greeting', text });
  }

  recon(screen: ReconScreen, text: string): void {
    this.events.push({ type: 'recon', screen, text });
  }

  friction(evt: Omit<FrictionEvent, 'type'>): void {
    this.events.push({ type: 'friction', ...evt });
  }

  dayNote(evt: Omit<DayNoteEvent, 'type'>): void {
    this.events.push({ type: 'day-note', ...evt });
  }

  // ── Protocol log (DC-S1) — recorded by the harness's single dispatch point, never here. ──

  protocolHeader(
    userId: string,
    brain: 'scripted' | 'prod',
    backend: 'real' | 'stub',
    recordedAt: string,
    persona?: string,
  ): void {
    this.protocol.push({
      seq: 0,
      kind: 'header',
      v: PROTOCOL_VERSION,
      userId,
      brain,
      backend,
      recordedAt,
      ...(persona !== undefined ? { persona } : {}),
    });
  }

  recordDispatch(event: GameEvent, response: GameResponse, beats?: GameResponse[]): void {
    this.protocol.push({
      seq: this.seq++,
      kind: 'dispatch',
      event,
      response,
      ...(beats && beats.length ? { beats } : {}),
    });
  }

  recordTick(dayNumber: number): void {
    this.protocol.push({ seq: this.seq++, kind: 'tick', dayNumber });
  }

  /** Count the free-text (`action.custom`) actions the brain RESOLVED in this run — the recorded
   *  dispatch stream's real non-work actions. Day-job work is excluded on purpose: its outcome is
   *  `kind: 'work'` at the engine, where `stripWorkInspiration` removes every positive roll grant,
   *  so only a free action's resolution can carry RA-2's inspiration. `AGENT_FORCE_FREE_ACTIONS`
   *  exists to put at least one per day in here. "Resolved" is the transcript's own contract
   *  ({@link freeActionsByDay}): an `ok:false` dispatch (no-rolls, empty action) never happened as
   *  an action, and neither did one that resolved through a bail (roll refunded, nothing rolled) or
   *  never resolved at all (an abandoned `session-expired` beat, a beat-cap dead-end). Derived from
   *  the protocol log, so a QA reader and a test read the same number. */
  freeActions(): number {
    return this.freeActionsByDay().reduce((total, perDay) => total + perDay, 0);
  }

  /** The same count split per game day — criterion 3 reads "at least one non-work action PER DAY",
   *  so the run summary needs the day granularity, not just the total. Sliced at each nightly
   *  `rest.begin`, the play loop's own day boundary; a day the run stopped inside (stalled, crashed)
   *  is the last slice. */
  freeActionsByDay(): number[] {
    const days: ProtocolDispatchEntry[][] = [[]];
    for (const entry of this.protocol) {
      if (entry.kind !== 'dispatch') continue;
      days[days.length - 1].push(entry);
      if (entry.event.type === 'rest.begin') days.push([]);
    }
    return days.filter((day) => day.length > 0).map(resolvedFreeActions);
  }

  /** The run's verb histogram on BOTH axes (contract §9), derived on demand like `summary()` so
   *  there are no cached counters to drift:
   *
   *  - `kinds` counts the `turn` events by `AgentMove.kind` — what the brain actually chose
   *    (`menu-pick`, `custom`, `choice`, `bail`, `sleep`, `recon`). Exact, and independent of the
   *    engine's reading of the action.
   *  - `verbs` counts the `outcome` events by the action model's own `distilledType`: a free label,
   *    open-vocabulary and model-authored, so it is a reading of what a persona reached for in the
   *    model's own words rather than an exact vocabulary shared with its priors (contract §9).
   *
   *  The two can disagree, and that disagreement is a finding of its own: a brain that `custom`-ed its
   *  way to a `rest` outcome played rest, whatever slot it reached for. */
  verbHistogram(): { kinds: Record<string, number>; verbs: Record<string, number> } {
    const kinds: Record<string, number> = {};
    const verbs: Record<string, number> = {};
    for (const e of this.events) {
      if (e.type === 'turn') kinds[e.chosen.kind] = (kinds[e.chosen.kind] ?? 0) + 1;
      else if (e.type === 'outcome' && e.verb) verbs[e.verb] = (verbs[e.verb] ?? 0) + 1;
    }
    return { kinds, verbs };
  }

  /** Roll up the log into a QA scoreboard. Derived on demand — no cached counters to drift. */
  summary(): TranscriptSummary {
    const s: TranscriptSummary = {
      turns: 0,
      outcomes: 0,
      deadEnds: 0,
      commutes: 0,
      dayBoundaries: 0,
      greetings: 0,
      recons: 0,
      frictions: 0,
      findings: { error: 0, warning: 0 },
    };
    for (const e of this.events) {
      switch (e.type) {
        case 'turn': s.turns++; break;
        case 'outcome': s.outcomes++; break;
        case 'dead-end': s.deadEnds++; break;
        case 'commute': s.commutes++; break;
        case 'day': s.dayBoundaries++; break;
        case 'finding': s.findings[e.severity]++; break;
        case 'greeting': s.greetings++; break;
        case 'recon': s.recons++; break;
        case 'friction': s.frictions++; break;
      }
    }
    return s;
  }
}

/** Count the free-text actions in one day's dispatch slice that actually RESOLVED. A custom
 *  dispatch counts when it returned an outcome itself, or when a later `action.choose` beat on the
 *  same action returned one without bailing: the decision loop's beats are the only dispatches
 *  between starting an action and its resolution, so anything else means this action never
 *  resolved — a bail (roll refunded, nothing rolled) or an abandoned beat (session-expired,
 *  internal, the beat cap) is not a free action the RA-2 dial can be read from. */
function resolvedFreeActions(slice: ProtocolDispatchEntry[]): number {
  let count = 0;
  for (let i = 0; i < slice.length; i++) {
    const start = slice[i];
    if (start.event.type !== 'action.custom' || !start.response.ok) continue;
    if (isResolvedOutcome(start.response)) {
      count++;
      continue;
    }
    for (let beat = i + 1; beat < slice.length; beat++) {
      const choose = slice[beat];
      if (choose.event.type !== 'action.choose') break;
      if (choose.event.selector.kind === 'bail') break;
      if (isResolvedOutcome(choose.response)) {
        count++;
        break;
      }
    }
  }
  return count;
}

/** An ok envelope carrying a completed action outcome. The bail arm resolves the action too but
 *  stamps the `bailed` colour intent, so rejecting it here is what keeps a bail out of the count. */
function isResolvedOutcome(response: GameResponse): boolean {
  return response.ok && response.view?.screen === 'outcome' && response.view.colorIntent !== 'bailed';
}
