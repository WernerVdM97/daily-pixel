/**
 * The agent-player run transcript (JSON-seam M4.2). A flat, append-only log of what the agent saw
 * and did — the QA/playtest artefact both goals build on: M4.4 turns exceptions/dead-ends into
 * `finding` events, M4.5 feeds the whole log to the critic. Deliberately plain data (no engine or
 * discord types) so it serialises straight to JSON for a repro.
 */

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
/** A QA finding (M4.4 fills these in; defined here so the shape is stable). */
export interface FindingEvent { type: 'finding'; severity: 'error' | 'warning'; summary: string; detail?: string }

export type TranscriptEvent = TurnEvent | OutcomeEvent | DeadEndEvent | DayBoundaryEvent | FindingEvent;

/** A minimal append-only sink. A class (not a bare array) so later slices can add derived
 *  summaries (finding counts, day tallies) without changing every call site. */
export class Transcript {
  readonly events: TranscriptEvent[] = [];

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

  finding(severity: 'error' | 'warning', summary: string, detail?: string): void {
    this.events.push({ type: 'finding', severity, summary, ...(detail ? { detail } : {}) });
  }
}
