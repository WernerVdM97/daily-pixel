/**
 * The playtest-critic seam (JSON-seam M4.5, goal b — see docs/engine/json-seam-build-plans.md).
 *
 * `PlaytestCriticGateway` is the feedback-pass peer to the move-picker `AgentPlayerGateway`: a
 * single `critique` method that reads a COMPLETED run (the transcript + its scoreboard) and returns
 * a qualitative `PlaytestReport`. Like the brain, it has a real DeepSeek implementation
 * (`ProdPlaytestCriticGateway`) and a deterministic stub (`ScriptedPlaytestCriticGateway`), so the
 * real critic is opt-in on a harness run and CI never touches the network.
 *
 * Imports only the plain transcript value types — no `discord.js`, no engine runtime — so the seam
 * stays transport-neutral (parent decision 3).
 */

import type {
  DayNoteEvent,
  FrictionEvent,
  ReconEvent,
  TranscriptEvent,
  TranscriptSummary,
} from './transcript.js';

/** A completed run handed to the critic: the full ordered event log plus the derived scoreboard.
 *  Plain data (the same shape that serialises to a repro JSON), so the critic is fed exactly what a
 *  human reviewer would read back. */
export interface CritiqueInput {
  events: TranscriptEvent[];
  summary: TranscriptSummary;
}

/** The critic's qualitative playtest report (goal b): the four named dimensions plus an overall
 *  read. Each field is a short prose paragraph the critic writes — not a score. */
export interface PlaytestReport {
  pacing: string;
  clarity: string;
  fun: string;
  difficulty: string;
  /** Overall verdict plus the single most important thing to fix. */
  summary: string;
}

// ── The persona review (spec § F, T5) — the SECOND voice, a different artefact from the expert
// critic above. The critic answers "is this well designed"; a persona review answers "did someone
// like me get engaged and stay fulfilled, and would I come back tomorrow". ──

/** One rubric cell (spec § F): 1-5, or `unobserved` for a criterion the SESSION had no chance to
 *  exercise. `unobserved` is load-bearing, not a nicety: a day-one run has no week three, so
 *  `aliveness` and `memory` are unobservable by construction, and a rubric that forced a low score
 *  there would manufacture false negatives on exactly the criteria the game is built around (spec
 *  § Instrument limits, § Risks). Both the parser and the aggregation accept either form. */
export type RubricValue = 1 | 2 | 3 | 4 | 5 | 'unobserved';

/** The five named criteria, each lifted from a pillar the game already claims (spec § The rubric). */
export interface PersonaRubric {
  /** engagement — was today's one visit worth it, and is tomorrow's? */
  ritualPull: RubricValue;
  /** engagement — were the dice and the danger legible, and worth caring about? */
  visibleStakes: RubricValue;
  /** fulfilment — is there a thread, project or bond in progress that I would miss? */
  somethingToBuild: RubricValue;
  /** fulfilment — did the world feel like it moves without me, and did that make showing up matter? */
  aliveness: RubricValue;
  /** fulfilment — would anything I did survive being forgotten, by me or by the world? */
  memory: RubricValue;
}

/** A `scores` cell. Deliberately 1-5 with no `unobserved`: every one of the five is observable in a
 *  single session (they rate the session, not the arc), so `unobserved` belongs to the rubric alone. */
export type PersonaScore = 1 | 2 | 3 | 4 | 5;

/** The persona's own five-dimension read of the session. `clarity`, `challenge` and `variety`
 *  deliberately repeat three of the expert critic's dimensions so the panel matrix and the expert
 *  report read side by side — they are not a second opinion on design quality (spec § F). */
export interface PersonaScores {
  engagement: PersonaScore;
  fulfilment: PersonaScore;
  clarity: PersonaScore;
  challenge: PersonaScore;
  variety: PersonaScore;
}

/** The first benchmark question, as a closed vocabulary so the panel can count it. */
export type ReturnTomorrow = 'yes' | 'probably' | 'no';

/** The review's one-line verdict, closed for the same reason. */
export type PersonaVerdict = 'would play again tomorrow' | 'would drift off' | 'would churn';

/** The per-persona review (spec § F): the three benchmark questions, the five-criterion rubric, the
 *  five session scores, and the persona's own prose. This is the panel's unit of work — one per
 *  persona per run — and it is what the aggregation reads. */
export interface PersonaReview {
  /** The persona's own name, lowercase (the run's `AGENT_PERSONA`). */
  persona: string;
  rubric: PersonaRubric;
  scores: PersonaScores;
  /** Would I come back tomorrow? */
  returnTomorrow: ReturnTomorrow;
  /** The one thing that would bring me back. */
  hook: string;
  /** What I am working toward that I would miss if I stopped — the fulfilment signal. `nothing` is
   *  a legitimate and important answer; the panel counts it. */
  building: string;
  /** The specific thing that would stop me playing. */
  quitTrigger: string;
  /** How soon, free text the prompt constrains to `day N` / `week N` / `month N` / `never on this
   *  evidence`. Kept as written (the model's phrasing is data); {@link parseQuitHorizon} buckets it
   *  for ordering. */
  quitHorizon: string;
  engaging: string[];
  boring: string[];
  clunky: string[];
  /** The single best moment, named so a designer can find it in the log. */
  best: string;
  /** The single worst moment, named. */
  worst: string;
  verdict: PersonaVerdict;
  /** Three to six sentences in the persona's own voice. */
  review: string;
}

/** What a persona review needs to read (spec § F). Whole transcript value types only — no engine,
 *  no `discord.js` — so the seam stays transport-neutral (the same rule as {@link CritiqueInput}),
 *  and the reviewer reads the same artefact a panel reader or a human would. */
export interface PersonaReviewInput {
  /** The persona this run played as. Selects the voice fragment the review is written in. */
  persona: string;
  /** The whole ordered run log, findings included — the reviewer's evidence for everything it says. */
  events: TranscriptEvent[];
  summary: TranscriptSummary;
  /** The per-day rating series (spec § E), in day order: engagement, fulfilment, the line on the
   *  day, and the arc note the day ended on. The headline artefact — a day series can show a decay
   *  no single verdict can. */
  dayNotes: DayNoteEvent[];
  /** Every friction the brain reported, recurrence tags included. This, not the score matrix, is
   *  the persona's design signal (spec § F). */
  frictions: FrictionEvent[];
  /** One rendered day-log block per day (spec § B), when the caller holds them. Optional: the
   *  harness owns TODAY's day log and does not retain it across days, so a caller that keeps them
   *  (an arc runner) passes them and a caller that does not simply omits the field. */
  dayLogs?: string[];
  /** The read-only screens the player consulted (spec § C), whole rendered text included — that
   *  text is why the recon event keeps it. */
  reconScreens: ReconEvent[];
}

/**
 * The bucket `parseQuitHorizon` puts a `quitHorizon` phrase in, ordered by how soon the persona
 * would leave: `day` < `week` < `month` < `never`. `unknown` sits outside that order on purpose — a
 * phrase the harness could not read is not evidence of a long horizon, so it must not sort as one.
 */
export type QuitHorizonKind = 'day' | 'week' | 'month' | 'never' | 'unknown';

/** A bucketed churn horizon — the orderable form of {@link PersonaReview.quitHorizon}, so T6's
 *  panel can sequence personas by churn horizon without trusting the model's phrasing. */
export interface QuitHorizon {
  kind: QuitHorizonKind;
  /** The figure the phrase carried (`week 2` → 2). Null when it carried none (`day`, `never`). */
  n: number | null;
  /** The horizon in days — 1 / 7 / 30 per unit, null when there is no bound to read. A `never`
   *  horizon is deliberately NOT forced onto this scale (it is unbounded, and this shape must stay
   *  JSON-clean, so no Infinity sentinel); order horizons by {@link compareQuitHorizons} instead. */
  days: number | null;
  /** The phrase as the model wrote it, trimmed (empty when absent). */
  raw: string;
}

/** The kind order for `compareQuitHorizons`: soonest churn first, `never` after every bounded
 *  horizon, and `unknown` last (unread evidence is not a long horizon). */
export const QUIT_HORIZON_RANK: Record<QuitHorizonKind, number> = {
  day: 0,
  week: 1,
  month: 2,
  never: 3,
  unknown: 4,
};

const DAYS_PER_UNIT: Record<'day' | 'week' | 'month', number> = { day: 1, week: 7, month: 30 };

/**
 * Bucket a persona's `quitHorizon` phrase (T5). Tolerant by design: the field is free text, the
 * prompt only *asks* for `day N` / `week N` / `month N` / `never on this evidence`, and a live model
 * will write `in about week 2`, `Month 3.`, `NEVER ON THIS EVIDENCE` or nothing at all. The panel's
 * sequence-by-churn-horizon must survive that, so this reads the phrase rather than the contract.
 *
 * A unit with no figure (`within a week`) is still that unit with `n: null`; a bare `never` is
 * `never`; anything else is `unknown`. An unreadable phrase is never rounded down to a short
 * horizon, because that would be a fabricated churn prediction.
 */
export function parseQuitHorizon(raw: string): QuitHorizon {
  const text = (raw ?? '').trim();
  const lower = text.toLowerCase();
  // `week 2`, `2 weeks`, `in week 2` — the figure may sit on either side of the unit.
  const match = lower.match(/\b(\d+)\s*(day|week|month)s?\b/) ?? lower.match(/\b(day|week|month)s?\s*(\d+)\b/);
  if (match) {
    const [digits, unit] = /^\d/.test(match[1]) ? [match[1], match[2]] : [match[2], match[1]];
    const n = Number(digits);
    const kind = unit as 'day' | 'week' | 'month';
    return { kind, n, days: n * DAYS_PER_UNIT[kind], raw: text };
  }
  const bare = lower.match(/\b(day|week|month)s?\b/);
  if (bare) return { kind: bare[1] as 'day' | 'week' | 'month', n: null, days: null, raw: text };
  if (/\bnever\b/.test(lower)) return { kind: 'never', n: null, days: null, raw: text };
  return { kind: 'unknown', n: null, days: null, raw: text };
}

/** Order two horizons soonest-first: by kind rank, then by figure (`week 1` before `week 2`), with a
 *  figure-less horizon of a kind sorting before a figured one of the same kind (`week` before
 *  `week 2` — the sooner of the two readings). */
export function compareQuitHorizons(a: QuitHorizon, b: QuitHorizon): number {
  const byKind = QUIT_HORIZON_RANK[a.kind] - QUIT_HORIZON_RANK[b.kind];
  if (byKind !== 0) return byKind;
  return (a.n ?? 0) - (b.n ?? 0);
}

export interface PlaytestCriticGateway {
  /** Read a completed run and return a `PlaytestReport`. Implementations THROW on an unusable
   *  response (unparseable JSON, a missing/empty dimension) — the caller owns what to do with a
   *  failed critique, not the gateway (same fail-loud contract as the brain). */
  critique(input: CritiqueInput): Promise<PlaytestReport>;

  /** Read a completed run as ONE persona and return its `PersonaReview` (spec § F). A separate
   *  artefact from `critique`, with its own prompt template and its own `llm_calls` row. Fails loud
   *  on any unusable reply: this IS the measurement, so a missing or mistyped field, or a rubric
   *  value outside 1..5 and `'unobserved'`, throws — a silent drop would leave a hole in the panel
   *  that reads exactly like a criterion nobody had an opinion on. */
  review(input: PersonaReviewInput): Promise<PersonaReview>;
}
