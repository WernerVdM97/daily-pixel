/**
 * The playtest-critic seam: the feedback-pass peer to the move-picker `AgentPlayerGateway`. `critique` reads a
 * COMPLETED run and returns a `PlaytestReport`; `review` reads it as ONE persona. `Prod*` implements both.
 */

import type {
  DayNoteEvent,
  FrictionEvent,
  ReconEvent,
  TranscriptEvent,
  TranscriptSummary,
} from './transcript.js';

/** A completed run handed to the critic: the full ordered event log plus the derived scoreboard.
 *  Plain data (the same shape that serialises to a repro JSON), so nothing is lost in the handover. */
export interface CritiqueInput {
  events: TranscriptEvent[];
  summary: TranscriptSummary;
}

/** The critic's qualitative playtest report: the four named dimensions plus an overall read. Each
 *  field is a short prose paragraph the critic writes — not a score. */
export interface PlaytestReport {
  pacing: string;
  clarity: string;
  fun: string;
  difficulty: string;
  /** Overall verdict plus the single most important thing to fix. */
  summary: string;
}

// ── The persona review — the SECOND voice, a different artefact from the expert critic above: the
// critic answers "is this well designed", the review answers "would someone like me come back". ──

/** One rubric cell: 1-5, or `unobserved` for a criterion the SESSION had no chance to exercise.
 *  Forcing a low score where a day-one run could not observe would manufacture false negatives. */
export type RubricValue = 1 | 2 | 3 | 4 | 5 | 'unobserved';

/** The five named criteria, each lifted from a pillar the game already claims. */
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
 *  deliberately repeat three of the expert critic's dimensions so the two reports read side by side. */
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

/** The per-persona review: the three benchmark questions, the five-criterion rubric, the five session
 *  scores, and the persona's own prose. This is the panel's unit of work, one per persona per run. */
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
   *  evidence`. Kept as written (the model's phrasing is data); {@link parseQuitHorizon} buckets it. */
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

/** What a persona review needs to read. Whole transcript value types only — no engine, no `discord.js`
 *  — so the seam stays transport-neutral, and the reviewer reads what a panel reader or human would. */
export interface PersonaReviewInput {
  /** The persona this run played as. Selects the voice fragment the review is written in. */
  persona: string;
  /** The whole ordered run log, findings included — the reviewer's evidence for everything it says. */
  events: TranscriptEvent[];
  summary: TranscriptSummary;
  /** The per-day rating series, in day order: engagement, fulfilment, the line on the day, and the arc
   *  note the day ended on. The headline artefact — a day series can show a decay no verdict can. */
  dayNotes: DayNoteEvent[];
  /** Every friction the brain reported, recurrence tags included. This, not the score matrix, is the
   *  persona's design signal. */
  frictions: FrictionEvent[];
  /** One rendered day-log block per day, when the caller holds them. Optional: the harness owns TODAY's
   *  day log and does not retain it across days, so an arc runner passes them and others omit. */
  dayLogs?: string[];
  /** The read-only screens the player consulted, whole rendered text included — that text is why the
   *  recon event keeps it. */
  reconScreens: ReconEvent[];
}

/**
 * The bucket `parseQuitHorizon` puts a `quitHorizon` phrase in, ordered by how soon the persona would leave:
 * `day` < `week` < `month` < `never`, with `unknown` OUTSIDE that order — unread evidence is not a long horizon.
 */
export type QuitHorizonKind = 'day' | 'week' | 'month' | 'never' | 'unknown';

/** A bucketed churn horizon — the orderable form of {@link PersonaReview.quitHorizon}, so the panel
 *  can sequence personas by churn horizon without trusting the model's phrasing. */
export interface QuitHorizon {
  kind: QuitHorizonKind;
  /** The figure the phrase carried (`week 2` → 2). Null when it carried none (`day`, `never`). */
  n: number | null;
  /** The horizon in days — 1 / 7 / 30 per unit, null when there is no bound to read. `never` is unbounded
   *  and deliberately not forced onto this scale (no Infinity sentinel); order with {@link compareQuitHorizons}. */
  days: number | null;
  /** The phrase as the model wrote it, trimmed (empty when absent). */
  raw: string;
}

/** The kind order for `compareQuitHorizons`: `unknown` FIRST, then the bounded horizons soonest churn first,
 *  `never` last. Showing the unreadable bucket last would pass off unread personas as the most committed. */
export const QUIT_HORIZON_RANK: Record<QuitHorizonKind, number> = {
  unknown: 0,
  day: 1,
  week: 2,
  month: 3,
  never: 4,
};

const DAYS_PER_UNIT: Record<'day' | 'week' | 'month', number> = { day: 1, week: 7, month: 30 };

/**
 * Bucket a persona's `quitHorizon` phrase: a unit with no figure is still that unit with `n: null`, a bare
 * `never` is `never`, anything else `unknown` — an unreadable phrase is never rounded into a prediction.
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

/** Order two horizons soonest-first: by kind rank, then by figure, with a figure-less horizon sorting
 *  before a figured one of the same kind (`week` before `week 2` — the sooner of the two readings). */
export function compareQuitHorizons(a: QuitHorizon, b: QuitHorizon): number {
  const byKind = QUIT_HORIZON_RANK[a.kind] - QUIT_HORIZON_RANK[b.kind];
  if (byKind !== 0) return byKind;
  return (a.n ?? 0) - (b.n ?? 0);
}

export interface PlaytestCriticGateway {
  /** Read a completed run and return a `PlaytestReport`. Implementations THROW on an unusable response
   *  (unparseable JSON, a missing or empty dimension) — the caller owns a failed critique. */
  critique(input: CritiqueInput): Promise<PlaytestReport>;

  /** Read a completed run as ONE persona and return its `PersonaReview` — a separate artefact from
   *  `critique`, with its own prompt and its own `llm_calls` row, failing loud on any unusable reply. */
  review(input: PersonaReviewInput): Promise<PersonaReview>;
}
