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
import type { AgentMove, LegalMove } from './AgentPlayerGateway.js';

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
export interface OutcomeEvent { type: 'outcome'; text: string }
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

export type TranscriptEvent =
  | TurnEvent
  | OutcomeEvent
  | DeadEndEvent
  | DayBoundaryEvent
  | CommuteEvent
  | FindingEvent
  | GreetingEvent;

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

  outcome(text: string): void {
    this.events.push({ type: 'outcome', text });
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

  // ── Protocol log (DC-S1) — recorded by the harness's single dispatch point, never here. ──

  protocolHeader(userId: string, brain: 'scripted' | 'prod', backend: 'real' | 'stub'): void {
    this.protocol.push({ seq: 0, kind: 'header', v: PROTOCOL_VERSION, userId, brain, backend });
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

  /** Roll up the log into a QA scoreboard. Derived on demand — no cached counters to drift. */
  summary(): TranscriptSummary {
    const s: TranscriptSummary = {
      turns: 0,
      outcomes: 0,
      deadEnds: 0,
      commutes: 0,
      dayBoundaries: 0,
      greetings: 0,
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
      }
    }
    return s;
  }
}
