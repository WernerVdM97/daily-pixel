/**
 * The agent-player run transcript: a flat, append-only log of what the agent saw and did, and the QA
 * artefact the repro and the critic read. A parallel `protocol` log rides along, one entry per dispatch.
 */

import { PROTOCOL_VERSION, type GameResponse, type RollVerdict } from '../protocol/envelope.js';
import type { GameEvent } from '../protocol/events.js';
import type { AgentMove, LegalMove, Recurrence, ReconScreen } from './AgentPlayerGateway.js';
import { viewToText } from './viewToText.js';

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
  /** The action model's own label for the action that produced this outcome — the outcome envelope's
   *  `facts.distilledType`, recorded verbatim. MODEL-AUTHORED and open-vocabulary: never keyword-matched from the text. */
  verb?: string;
  /** The d20 the action rolled, and the DC it was decided against — lifted from the outcome
   *  envelope's `roll` fact. Absent together when the action rolled no dice. */
  d20?: number;
  dc?: number;
  /** The item/stat bonus the engine added to the d20, when the roll carried one. */
  bonus?: number;
}
export interface DeadEndEvent { type: 'dead-end'; reason: string; detail?: string }
export interface DayBoundaryEvent { type: 'day'; dayNumber: number; note: string }
/** The day-job work flow's transient commute beat (the "you moved to work" screen) — an
 *  informational beat the acting player sees between picking the job and its outcome. */
export interface CommuteEvent { type: 'commute'; destination: string; text: string }
/** A QA finding. `error` = an invariant breach or an uncaught exception; `warning` = a soft anomaly (a
 *  stall, an illegal move, a capped loop) that didn't corrupt state. */
export interface FindingEvent { type: 'finding'; severity: 'error' | 'warning'; summary: string; detail?: string }
/** A scripted day-start greeting — the screen text of the `hi.open` parity beat. Pure derived data,
 *  never wired into the play loop here. */
export interface GreetingEvent { type: 'greeting'; text: string }
/** A recon screen the brain asked to read — free, deterministic, and re-readable here for the critic,
 *  which is why the whole rendered text is kept and not just the screen name. */
export interface ReconEvent { type: 'recon'; screen: ReconScreen; text: string }
/** A friction the brain reported this turn. The recurrence tag is the panel's unit: in a daily ritual a
 *  screen read every day costs more than a once-a-session clunk, so it ranks by exposure, not count. */
export interface FrictionEvent {
  type: 'friction';
  dayNumber: number;
  what: string;
  severity: number;
  recurrence: Recurrence;
}
/** The day's note: the rating pair, one line on the day, and the arc note as it stood at the end of it.
 *  Written when the day closes, whatever closed it; the last note the brain reported is the one kept. */
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

// ── The parallel protocol log — plain JSON entries, no timestamps (determinism). ──

/** The header entry (seq 0): the protocol version + session identity so a replay knows which
 *  backend class to use (`backend`) and how to interpret a mismatch (`brain`). */
export interface ProtocolHeaderEntry {
  seq: 0;
  kind: 'header';
  v: number;
  userId: string;
  brain: 'scripted' | 'prod';
  backend: 'real' | 'stub';
  /** The wall clock the session was recorded against, ISO-8601. Replay pins the process clock to it, which
   *  discharges the same-weekday caveat for the UTC reads — but not for the greeting's LOCAL weekday read. */
  recordedAt: string;
  /** The persona the run played as, so a recording is attributable in replay. Absent on a persona-less
   *  run — which is what keeps every pre-persona recording byte-identical. */
  persona?: string;
}

/** One raw dispatch: the exact `GameEvent` sent and the final `GameResponse` envelope returned, plus the
 *  interstitial beats (`loading`/`commute`/thinking) when recorded (the `recordBeats` knob, default off). */
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

/** A run-level roll-up over the transcript — the QA scoreboard `play.ts` prints and the critic reads
 *  first for orientation. Pure derived data (recomputed from `events`), never a second source of truth. */
export interface TranscriptSummary {
  turns: number;
  outcomes: number;
  deadEnds: number;
  commutes: number;
  /** Day boundaries crossed (nightly ticks). */
  dayBoundaries: number;
  /** Scripted day-start greetings. */
  greetings: number;
  /** Recon screens the brain asked to read. */
  recons: number;
  /** Frictions the brain reported. */
  frictions: number;
  findings: { error: number; warning: number };
}

/** Below this many non-work resolutions a grant rate is not quotable: at n = 50 a 10% reading's 95% CI
 *  tops out at ~18%, so the band's upper edge (~19% at 3.7 rolls/day) binds. Report count, not a rate. */
export const QUOTABLE_ELIGIBLE_FLOOR = 50;

/** One played day of the RA-2 reading. */
export interface InspirationDay {
  /** 1-based play order. */
  day: number;
  resolutions: number;
  rolls: number;
  eligible: number;
  grants: number;
}

/** The RA-2 inspiration dial's reading, derived from the protocol log the way `freeActions()` is. Read the
 *  rate against `eligible`: `stripWorkInspiration` drops every grant on a day-job action by design. */
export interface InspirationReading {
  /** Actions the brain completed — the whole-run denominator. */
  resolutions: number;
  /** Those that spent a roll, judged by the engine's roll header. A floor: a combat resolution renders
   *  its contest inside the combat card and carries no header. */
  rolls: number;
  /** Those on a non-work action — the denominator the dial is tuned against. */
  eligible: number;
  /** The day-job share of `resolutions`. */
  work: number;
  /** Those whose outcome carried the engine's own `✨ Inspired:` named-reward line. */
  grants: number;
  byDay: InspirationDay[];
}

/** Format the RA-2 dial for the run summary: the rate against both denominators, the roll cadence and
 *  the verdict. The forced arm's work/free mix is not the band's calibrated mix, so it prints too. */
export function formatInspirationDial(dial: InspirationReading): string {
  const rate = (grants: number, denominator: number): string =>
    denominator === 0 ? 'n/a' : `${((grants / denominator) * 100).toFixed(1)}% (${grants}/${denominator})`;
  const verdict =
    dial.eligible >= QUOTABLE_ELIGIBLE_FLOOR
      ? 'quotable'
      : `NOT quotable — ${dial.eligible} eligible resolution(s), floor is ${QUOTABLE_ELIGIBLE_FLOOR}`;
  return (
    '\n── RA-2 inspiration dial ──\n' +
    dial.byDay
      .map(
        (d) =>
          `  day ${d.day}: ${d.resolutions} resolution(s), ${d.rolls} rolled, ${d.eligible} eligible, ${d.grants} grant(s)`,
      )
      .join('\n') +
    `\n  total: ${dial.resolutions} resolution(s), ${dial.rolls} rolled, ${dial.eligible} eligible (non-work), ` +
    `${dial.work} work, ${dial.grants} grant(s)\n` +
    `  grant rate: ${rate(dial.grants, dial.eligible)} of eligible, ${rate(dial.grants, dial.resolutions)} of all resolutions\n` +
    `  rolls per played day: ${dial.byDay.length === 0 ? 'n/a' : (dial.rolls / dial.byDay.length).toFixed(2)}\n` +
    `  ${verdict}`
  );
}

/** A minimal append-only sink. A class (not a bare array) so later slices can add derived summaries
 *  (finding counts, day tallies) without changing every call site. */
export class Transcript {
  readonly events: TranscriptEvent[] = [];

  /** The parallel protocol log — one entry per dispatch plus the header and nightly-tick markers,
   *  recorded at the single `dispatch()` point inside the harness. */
  readonly protocol: ProtocolEntry[] = [];

  /** Dispatch/tick sequence numbers — start at 1 (0 is reserved for the header). */
  private seq = 1;

  turn(screen: 'menu' | 'decision', text: string, offered: LegalMove[], chosen: AgentMove): void {
    this.events.push({ type: 'turn', screen, text, offered: offered.map((m) => m.label), chosen });
  }

  outcome(text: string, verb?: string, roll?: RollVerdict): void {
    this.events.push({
      type: 'outcome',
      text,
      ...(verb ? { verb } : {}),
      ...(roll ? { d20: roll.d20, dc: roll.dc, ...(roll.bonus !== undefined ? { bonus: roll.bonus } : {}) } : {}),
    });
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

  // ── Protocol log — recorded by the harness's single dispatch point, never here. ──

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

  /** Count the free-text (`action.custom`) actions the brain RESOLVED in this run, derived from the protocol
   *  log so a QA reader and a test read the same number. Day-job work is excluded. */
  freeActions(): number {
    return this.freeActionsByDay().reduce((total, perDay) => total + perDay, 0);
  }

  /** The same count split per game day — criterion 3 reads "at least one non-work action PER DAY". */
  freeActionsByDay(): number[] {
    return this.daySlices().map((slice) => resolvedActions(slice).filter((a) => a.kind === 'free').length);
  }

  /** The RA-2 dial's numbers: the grant rate with both denominators, the roll cadence, and the run's
   *  own work/free mix. Derived on demand like every other counter here. */
  inspiration(): InspirationReading {
    const byDay = this.daySlices().map((slice, i) => {
      const actions = resolvedActions(slice);
      return {
        day: i + 1,
        resolutions: actions.length,
        rolls: actions.filter((a) => a.rolled).length,
        eligible: actions.filter((a) => a.kind === 'free').length,
        grants: actions.filter((a) => a.granted).length,
      };
    });
    const total = (pick: (day: InspirationDay) => number) => byDay.reduce((sum, day) => sum + pick(day), 0);
    return {
      resolutions: total((d) => d.resolutions),
      rolls: total((d) => d.rolls),
      eligible: total((d) => d.eligible),
      work: total((d) => d.resolutions - d.eligible),
      grants: total((d) => d.grants),
      byDay,
    };
  }

  /** The dispatch log sliced into played days, cut at each nightly `rest.begin`; a slice with no dispatch
   *  is dropped. The index is play order, not the world's day number (`AGENT_SKIP_DAYS` breaks that match). */
  private daySlices(): ProtocolDispatchEntry[][] {
    const days: ProtocolDispatchEntry[][] = [[]];
    for (const entry of this.protocol) {
      if (entry.kind !== 'dispatch') continue;
      days[days.length - 1].push(entry);
      if (entry.event.type === 'rest.begin') days.push([]);
    }
    return days.filter((day) => day.length > 0);
  }

  /** The run's verb histogram on BOTH axes, derived on demand like `summary()` so no counter can drift.
   *  `kinds` counts the brain's chosen `AgentMove.kind`; `verbs` counts the model-authored outcome labels. */
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

/** One action that RESOLVED in a day's dispatch slice: what it was, whether it spent a roll, and whether
 *  the outcome reported a grant. */
interface ResolvedAction {
  kind: 'work' | 'free';
  rolled: boolean;
  granted: boolean;
}

/** The actions that resolved in one day's slice, in order. A start dispatch (`dayjob.start` = work,
 *  `action.custom` = free text) counts when it or a later non-bail `action.choose` beat returned an outcome. */
function resolvedActions(slice: ProtocolDispatchEntry[]): ResolvedAction[] {
  const actions: ResolvedAction[] = [];
  for (let i = 0; i < slice.length; i++) {
    const start = slice[i];
    const kind =
      start.event.type === 'dayjob.start' ? 'work'
      : start.event.type === 'action.custom' ? 'free'
      : null;
    if (kind === null || !start.response.ok) continue;
    const own = readOutcome(start.response);
    if (own !== null) {
      actions.push({ kind, ...own });
      continue;
    }
    for (let beat = i + 1; beat < slice.length; beat++) {
      const choose = slice[beat];
      if (choose.event.type !== 'action.choose') break;
      if (choose.event.selector.kind === 'bail') break;
      const outcome = readOutcome(choose.response);
      if (outcome !== null) {
        actions.push({ kind, ...outcome });
        break;
      }
    }
  }
  return actions;
}

/** The engine's roll header, `🎲 <d20> [+ bonus]  vs  <dc>` on a line of its own. */
const ROLL_HEADER = /^.*🎲.* {2}vs {2}\d.*$/m;
/** The engine's named-reward line, rendered whenever a positive `modify_rolls_remaining` landed. */
const INSPIRED_LINE = /^.*✨ Inspired: \+\d+ rolls?$/m;

/** Read one resolution off the rendered message. The markers are engine-rendered, but the haystack holds
 *  the model's prose too, so a model line shaped like one counts; null is a non-completed outcome or a bail. */
function readOutcome(response: GameResponse): { rolled: boolean; granted: boolean } | null {
  if (!response.ok || response.view?.screen !== 'outcome' || response.view.colorIntent === 'bailed') {
    return null;
  }
  const text = viewToText(response.view);
  return { rolled: ROLL_HEADER.test(text), granted: INSPIRED_LINE.test(text) };
}
