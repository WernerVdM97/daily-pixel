/**
 * The agent-player run transcript: a flat, append-only log of what the agent saw and did, and the QA
 * artefact the repro and the critic read. A parallel `protocol` log rides along, one entry per dispatch.
 */

import { PROTOCOL_VERSION, isRollVerdict, type GameResponse, type RollVerdict } from '../protocol/envelope.js';
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
  /** Lifted from the outcome envelope's `roll` fact; all three are absent when the action rolled no dice. */
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

export type DcBand = 'routine' | 'hard' | 'daunting';

/** The live prompt set's ladder, which DECIDE authors each option's FINAL DC into
 *  (`assets/prompts/decision-prompts/<version>/decide/BASE.md`). Not `dangerTier`, which bands a DC
 *  for display against a different scale. */
export const DC_LADDER: readonly { band: DcBand; min: number; max: number }[] = [
  { band: 'routine', min: 11, max: 13 },
  { band: 'hard', min: 16, max: 18 },
  { band: 'daunting', min: 20, max: 24 },
];

/** The daunting band's floor: the bar a re-probe reads a run's highest authored DC against, read off
 *  the ladder so a rung edit cannot leave it stale. */
export const DAUNTING_FLOOR = Math.min(...DC_LADDER.filter((r) => r.band === 'daunting').map((r) => r.min));

/** Which band a final DC lands in, or null for the gaps (14, 15, 19) and the tails outside the ladder. */
export function dcBand(dc: number): DcBand | null {
  for (const rung of DC_LADDER) if (dc >= rung.min && dc <= rung.max) return rung.band;
  return null;
}

/** A run's authored-DC distribution. Read `work` before the bands: a day-job-dominated run says
 *  nothing about DECIDE. */
export interface DifficultyBandReading {
  /** Actions the brain completed. */
  resolutions: number;
  /** Those whose outcome carried a roll, so a DC exists to band. */
  rolled: number;
  /** Rolled DCs on a day-job action — the harness's blind spot, reported so it cannot be read as DECIDE. */
  work: number;
  byBand: Record<DcBand, number>;
  /** Rolled DCs in the ladder's own gaps (14, 15, 19), which no band covers. */
  gaps: number;
  /** Rolled DCs outside the ladder's ends (below 11 or above 24). */
  outside: number;
  /** The highest rolled DC and its band; null when nothing rolled. */
  max: { dc: number; band: DcBand | null } | null;
  /** Every rolled DC, ascending, with how many resolutions landed on it. */
  distribution: { dc: number; count: number }[];
}

/** Format the authored-DC distribution for the run summary. */
export function formatDifficultyBands(reading: DifficultyBandReading): string {
  const heading = '\n── RA-1 difficulty bands (decide ladder) ──';
  if (reading.max === null) return `${heading}\n  no rolled DC — nothing to band`;
  const rung = DC_LADDER.map((r) => `${r.band} ${r.min}-${r.max}: ${reading.byBand[r.band]}`).join('  ');
  const tally = reading.distribution.map((d) => `${d.dc}×${d.count}`).join(', ');
  const reached =
    reading.max.dc >= DAUNTING_FLOOR
      ? `daunting band reached (floor ${DAUNTING_FLOOR})`
      : `daunting band NOT reached (floor ${DAUNTING_FLOOR})`;
  return (
    `${heading}\n` +
    `  rolled DCs: ${reading.rolled} of ${reading.resolutions} resolution(s) — ${reading.work} work, ` +
    `${reading.rolled - reading.work} free\n` +
    `  ${rung}\n` +
    `  unbanded: ${reading.gaps} in the ladder's gaps, ${reading.outside} outside it\n` +
    `  distribution: ${tally}\n` +
    `  max: ${reading.max.dc} (${reading.max.band ?? 'off-ladder'}) — ${reached}`
  );
}

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
  /** Those whose outcome carried the envelope's roll fact. A floor: a multi-round fight's earlier rounds
   *  resolve as decisions and never reach an outcome. */
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

  /** The authored final DCs this run rolled against, banded on the decide ladder — the reading a
   *  daunting-band re-probe takes. Derived from the protocol log, so work and free actions split. */
  difficultyBands(): DifficultyBandReading {
    const actions = this.daySlices().flatMap((slice) => resolvedActions(slice));
    const rolled = actions.filter((a) => a.dc !== undefined);
    const byBand: Record<DcBand, number> = { routine: 0, hard: 0, daunting: 0 };
    const counts = new Map<number, number>();
    let gaps = 0;
    let outside = 0;
    let max: DifficultyBandReading['max'] = null;
    for (const action of rolled) {
      const dc = action.dc!;
      const band = dcBand(dc);
      if (band === null) {
        if (dc < DC_LADDER[0].min || dc > DC_LADDER[DC_LADDER.length - 1].max) outside++;
        else gaps++;
      } else byBand[band]++;
      counts.set(dc, (counts.get(dc) ?? 0) + 1);
      if (max === null || dc > max.dc) max = { dc, band };
    }
    return {
      resolutions: actions.length,
      rolled: rolled.length,
      work: rolled.filter((a) => a.kind === 'work').length,
      byBand,
      gaps,
      outside,
      max,
      distribution: [...counts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([dc, count]) => ({ dc, count })),
    };
  }

  /** The RA-2 dial's numbers: the grant rate with both denominators, the roll cadence, and the run's
   *  own work/free mix. Derived on demand like every other counter here. */
  inspiration(): InspirationReading {
    const byDay = this.daySlices().map((slice, i) => {
      const actions = resolvedActions(slice);
      return {
        day: i + 1,
        resolutions: actions.length,
        rolls: actions.filter((a) => a.dc !== undefined).length,
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

/** One action that RESOLVED in a day's dispatch slice: what it was, the DC it rolled against (absent
 *  when it spent no roll), and whether the outcome reported a grant. */
interface ResolvedAction {
  kind: 'work' | 'free';
  dc?: number;
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

/** The engine's named-reward line, rendered whenever a positive `modify_rolls_remaining` landed. */
const INSPIRED_LINE = /^.*✨ Inspired: \+\d+ rolls?$/m;

/** Read one resolution off its outcome envelope: the roll fact carries the DC, so a combat terminal card
 *  (which renders no roll header) counts too, and only the grant still comes off the rendered line.
 *  Null is a non-completed outcome or a bail. */
function readOutcome(response: GameResponse): { dc?: number; granted: boolean } | null {
  if (!response.ok || response.view?.screen !== 'outcome' || response.view.colorIntent === 'bailed') {
    return null;
  }
  const roll = response.facts?.roll;
  const granted = INSPIRED_LINE.test(viewToText(response.view));
  return { ...(isRollVerdict(roll) ? { dc: roll.dc } : {}), granted };
}
