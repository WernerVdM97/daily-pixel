#!/usr/bin/env node
/**
 * T6 — the panel aggregation (spec § G/§ H, contract §9), `npm run agent:panel -- <dir>`.
 *
 * A panel is N processes: each persona is its own `agent:play` run with its own `:memory:` DB, and
 * the engine has no cross-process continuation (spec § Instrument limits). So the aggregate can
 * never be something one run prints — this is an OFFLINE reader that takes a directory of
 * `<AGENT_OUT>.reviews.json` files (T5's self-sufficient payload) and writes `panel.md` + `panel.json`
 * beside them.
 *
 * The split that matters: {@link aggregatePanel} and {@link renderPanelMarkdown} are PURE functions
 * over an array of parsed review files, and every number the panel reports is produced there. The
 * file IO below them is thin enough to read in one screen, so T9 can unit-test the aggregation,
 * exposure ranking and sparkline without ever touching a filesystem.
 *
 * Two things the panel must never do, both from spec § Risks:
 *
 * - **Read a day-one run as a verdict on month three.** A breadth panel is an onboarding instrument:
 *   day one has no memory, no co-play and no content exhaustion, so the rubric cells for `aliveness`
 *   and `memory` are `unobserved` by construction. Coverage is what stops a short run reading as a
 *   design failure, and the panel's own header says so before any number.
 * - **Present model-authored labels as a vocabulary.** `actionVerbs` counts the outcome envelope's
 *   `distilledType`, which is free text the action model writes ("one word preferred"), NOT the
 *   engine's classify families (contract §9, the correction found while implementing T5). The
 *   priors-versus-behaviour comparison therefore runs on `verbs` (move kinds), which is exact.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REVIEW_FILE_VERSION, type ReviewFile } from './reviewFile.js';
import {
  compareQuitHorizons,
  parseQuitHorizon,
  type PersonaVerdict,
  type QuitHorizon,
  type RubricValue,
} from './PlaytestCriticGateway.js';
import type { Recurrence } from './AgentPlayerGateway.js';
import type { CallKindBreakdown } from './llmCostSummary.js';

/** The `panel.json` FORMAT version. Bumped when the aggregated shape changes incompatibly, so a
 *  later comparison against the 2026-09-13 baseline can refuse a report it cannot read rather than
 *  diff two different things. Not tied to {@link REVIEW_FILE_VERSION}: this is the panel's own
 *  output, and the panel can be re-run from the same review files at any time.
 *
 * v2: exposure sums each report's own severity x weight instead of multiplying one report's severity
 * by another's tag (contract §9's refinement), `friction.themes` is the FULL ranked list with the
 * ritual subset beside it, the run length comes from the summary, and the score rows carry `hook`
 * while the series carries the per-day arc notes. Two panels either side of this differ in their
 * numbers, so a diff across the boundary is refused rather than read as a change in the game.
 *
 * v3: friction reports described in different words collapse into ONE theme
 * ({@link FRICTION_MERGE_THRESHOLD}), so a defect four personas hit is finally visible as a
 * cross-persona signal instead of four once-each themes. Every theme carries the raw per-report list
 * (`reports`) and its distinct `phrasings` count, and the ranking CHANGES: themes merge and their
 * exposure adds up. A v2 panel and a v3 panel are not comparable, so the boundary is refused rather
 * than read as the design moving. */
export const PANEL_FILE_VERSION = 3;

/** The panel's two file outputs, written beside the reviews it reads. */
export const PANEL_MARKDOWN_FILE = 'panel.md';
export const PANEL_JSON_FILE = 'panel.json';

/**
 * Projected exposure per REPORTED friction over a six-month campaign (contract §9): how many sessions
 * a player is expected to meet it in. `once` is trivia, `periodic` reads as roughly fortnightly,
 * `ritual` as every single session — this is the documented ASSUMPTION behind the ranking, not a
 * measurement. Each weight multiplies the severity of the report it came from, and a theme's exposure
 * is the sum of those per-report products ({@link aggregateFrictions}): the weights are the whole
 * reason one persona meeting a daily defect outranks the panel meeting a milder one once.
 */
export const RECURRENCE_WEIGHT: Record<Recurrence, number> = { once: 1, periodic: 13, ritual: 180 };

/** The tag order used wherever recurrences are listed, cheapest first. */
export const RECURRENCE_ORDER: readonly Recurrence[] = ['once', 'periodic', 'ritual'];

/** One line in the panel's own header, so the numbers below are read as relative to the assumption. */
export const EXPOSURE_NOTE =
  'Exposure = the sum, over every report of the theme, of that report\'s own severity x the ' +
  'RECURRENCE_WEIGHT of its own tag { once 1, periodic 13, ritual 180 }, over a six-month campaign. ' +
  'Worst severity, the tags seen and the persona count are printed as columns and are never ' +
  'multiplied together: that would charge one report for another report\'s severity. It is an ' +
  'assumption, not a measurement: it exists so a daily grievance outranks a once-only clunk.';

/** The caveat that must ride with `actionVerbs` (contract §9). */
export const ACTION_VERB_NOTE =
  'These are MODEL-AUTHORED labels: the count is by the outcome envelope\'s `facts.distilledType`, ' +
  'which the action model writes as "a single lowercase label capturing the action\'s essence, one ' +
  'word preferred": open vocabulary, so a run may emit `chore`, `patrol` or `haggle`. This is NOT ' +
  'the engine\'s classify families and it is not a persona\'s named verb priors. Read it as what a ' +
  'label table can honestly say (which actions this persona reached for, in the model\'s words); the ' +
  'priors-versus-behaviour comparison above runs on move kinds, which is exact.';

/** Eight levels, so `1..5` maps onto the full ramp and a flat series renders as a flat line. */
export const SPARK_GLYPHS = '▁▂▃▄▅▆▇█';

const SCORE_DIMENSIONS = ['engagement', 'fulfilment', 'clarity', 'challenge', 'variety'] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

const RUBRIC_CRITERIA = ['ritualPull', 'visibleStakes', 'somethingToBuild', 'aliveness', 'memory'] as const;
export type RubricCriterion = (typeof RUBRIC_CRITERIA)[number];

/** The `summary` fields the panel adds up or prints as a figure. */
const SUMMARY_COUNTS = ['turns', 'outcomes', 'deadEnds', 'dayBoundaries', 'greetings'] as const;

/** The move kinds the histogram table always carries a column for, in the contract's §1.1 order —
 *  the panel's core read is the split between them, so a kind nobody used must still be visible as
 *  a column of zeroes rather than absent. */
const MOVE_KINDS = ['menu-pick', 'custom', 'choice', 'bail', 'sleep', 'recon'] as const;

/** A bad input file. Loud by design (contract §9): a missing directory, an unreadable file or a
 *  version mismatch is an error, never a silent skip — a panel that quietly drops a persona reads
 *  exactly like a panel where that persona had nothing to say. */
export class PanelInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PanelInputError';
  }
}

// ── Aggregation (pure) ────────────────────────────────────────────────────────────────────────

export interface PanelShapeGroup {
  label: 'breadth' | 'arc';
  /** How many personas ran this shape. */
  personas: number;
  /** Days each of them played, in the panel's canonical persona order. */
  days: number[];
}

export interface PanelComposition {
  personas: number;
  /** Personas grouped by how many days they played — the panel's own shape, stated up front. */
  shapes: PanelShapeGroup[];
  /** Total persona-days the panel paid for. */
  personaDays: number;
}

export interface PanelRunSummary {
  persona: string;
  /** ISO-8601 `recordedAt` from the protocol header, null when the file carried no header. */
  recordedAt: string | null;
  /** Days the run PLAYED, from the summary — never from its day notes. */
  days: number;
  /** Days it actually rated, i.e. `days` minus the holes. */
  rated: number;
  /** The days in `1..days` with no day note. */
  unratedDays: number[];
  turns: number;
  outcomes: number;
  deadEnds: number;
  findings: { error: number; warning: number };
  costCalls: number;
  costTokens: number;
}

export interface PanelScoreRow {
  persona: string;
  scores: Record<ScoreDimension, number>;
  /** Would I come back tomorrow? Spec § F's benchmark question 1. */
  returnTomorrow: string;
  /** The one thing that would bring me back — the retention answer that goes with the churn
   *  trigger printed in the distinctiveness table (spec § F: `quitHorizon`, `hook` and `building`
   *  are the fields the design goal actually needs). */
  hook: string;
  verdict: PersonaVerdict;
  quitHorizon: QuitHorizon;
}

export interface RubricCriterionSummary {
  criterion: RubricCriterion;
  /** Personas that scored it 1-5 — `unobserved` is NOT coverage. */
  coverage: number;
  /** Personas that returned `unobserved` for it. */
  unobserved: number;
  /** Mean of the scored values, null when nobody could score it. Never 0, never NaN: a criterion
   *  no session could reach has no mean, and printing one would be the false negative the
   *  `unobserved` rule exists to prevent (spec § Risks). */
  mean: number | null;
}

export interface PanelRubricRow {
  persona: string;
  values: Record<RubricCriterion, number | 'unobserved'>;
}

export interface PanelSeriesRow {
  persona: string;
  /** Days the run played (summary-derived: a lost note never shortens the run) and the day numbers
   *  it actually rated, in day order. */
  played: number;
  days: number[];
  /** The days in `1..played` with no note — printed, so a hole is visible rather than silently
   *  shrinking the series. */
  unrated: number[];
  engagement: number[];
  fulfilment: number[];
  engagementSpark: string;
  fulfilmentSpark: string;
  /** The arc note each rated day ended on, paired with its day, in day order. Spec § G's read is
   *  *the day the arc note stops growing*: once the note repeats verbatim the run had nothing new
   *  to build, and the closing note alone cannot show when that happened. */
  arcNotes: Array<{ day: number; note: string }>;
}

export interface FrictionTheme {
  /** The normalised representative phrasing ({@link normalizePhrase} of {@link label}). Reported for
   *  a consumer that wants the theme's key; the GROUPING was by {@link FRICTION_MERGE_THRESHOLD}, so
   *  this is no longer the value every report shares. */
  theme: string;
  /** The display form: the first `what` seen for this theme, trimmed, in the panel's canonical
   *  order. See {@link aggregateFrictions} for why the representative is the first rather than the
   *  longest. */
  label: string;
  /** Distinct personas that reported it, in the panel's canonical row order. */
  personas: string[];
  personaCount: number;
  /** Total reports, one per friction event — a persona reporting it five times counts five here
   *  and once in {@link personaCount}, which is what stops one grievance dominating the ranking. */
  count: number;
  /** Distinct WORDINGS that merged into this theme. `1` means exact-text grouping would have
   *  produced the same theme; anything higher is a merge of differently worded reports of one
   *  complaint, which is the whole point of {@link FRICTION_MERGE_THRESHOLD} — and the count that
   *  makes a silent merge visible in `panel.md`. */
  phrasings: number;
  /** EVERY report that went into this theme, in the panel's canonical order and in report order
   *  within a persona (so `reports.length === count`). Nothing is hidden by a merge: the reader can
   *  always see which sentences were collapsed, and re-check the judgement. */
  reports: FrictionReportRef[];
  worstSeverity: number;
  /** The tags seen, cheapest first. */
  recurrences: Recurrence[];
  /** The sum over reports of `severity x RECURRENCE_WEIGHT[recurrence]` — see {@link EXPOSURE_NOTE}.
   *  NOT the worst severity times the dearest tag: those are attributes of different reports. */
  exposure: number;
  /** True when ANY report carried the `ritual` tag: met every session by someone is a design
   *  finding, so these are listed apart from the rest however mild the individual reports read. */
  ritual: boolean;
}

/** One report as it went into a {@link FrictionTheme}: the friction event plus the persona that
 *  raised it, so a merged theme's provenance is readable straight out of `panel.json`. */
export interface FrictionReportRef {
  persona: string;
  dayNumber: number;
  /** The phrase as the brain wrote it (trimmed), NOT the normalised form. */
  what: string;
  severity: number;
  recurrence: Recurrence;
}

export interface VerbHistogramRow {
  persona: string;
  total: number;
  /** Counts by `AgentMove.kind`. Exact — this is the table the anti-theatre check reads. */
  kinds: Record<string, number>;
  /** `custom` as a share of turns: the success criterion the 2026-09-13 baseline scored at zero. */
  freeTextShare: number;
}

export interface ActionVerbRow {
  persona: string;
  total: number;
  /** Observed `distilledType` labels, most frequent first, ties alphabetical for a stable report. */
  labels: Array<{ label: string; count: number }>;
}

export interface DistinctivenessDuplicate {
  /** A normalised value two or more personas produced. */
  value: string;
  personas: string[];
}

export interface PanelDistinctiveness {
  rows: Array<{
    persona: string;
    /** The arc note the run's last day ended on, '' when it ended on none. */
    arcNote: string;
    quitTrigger: string;
    arcNoteShared: boolean;
    quitTriggerShared: boolean;
  }>;
  distinctArcNotes: number;
  distinctQuitTriggers: number;
  duplicateArcNotes: DistinctivenessDuplicate[];
  duplicateQuitTriggers: DistinctivenessDuplicate[];
  missingArcNotes: string[];
}

export interface FulfilmentSignal {
  /** Personas that named something they were building. */
  named: Array<{ persona: string; building: string }>;
  /** Personas whose honest answer was `nothing` — the long-arc verdict, counted prominently. */
  nothing: string[];
  namedCount: number;
  nothingCount: number;
}

export interface PanelCost {
  runs: number;
  totalCalls: number;
  totalTokens: number;
  /** Per-call-kind totals merged across runs, shares recomputed over the whole panel. */
  byCallKind: CallKindBreakdown[];
  perRun: Array<{ persona: string; calls: number; tokens: number }>;
}

export interface PanelReport {
  v: number;
  composition: PanelComposition;
  runs: PanelRunSummary[];
  scores: PanelScoreRow[];
  rubric: { rows: PanelRubricRow[]; criteria: RubricCriterionSummary[] };
  series: PanelSeriesRow[];
  friction: {
    /** EVERY ranked theme, ritual-tagged ones included, so a consumer that sums this list cannot
     *  silently drop the ritual half. */
    themes: FrictionTheme[];
    /** The ritual-tagged subset, the same objects as they appear in {@link themes}. */
    ritual: FrictionTheme[];
    exposureNote: string;
  };
  fulfilment: FulfilmentSignal;
  histogram: { kinds: string[]; rows: VerbHistogramRow[] };
  actionVerbs: ActionVerbRow[];
  distinctiveness: PanelDistinctiveness;
  cost: PanelCost;
}

/** Map a value series onto {@link SPARK_GLYPHS} over its 1-5 scale. Empty in, empty out — the
 *  caller decides how to say "no day notes", because a blank sparkline and a flat one must not
 *  look alike. */
export function sparkline(values: readonly number[], min = 1, max = 5): string {
  if (values.length === 0) return '';
  const span = max - min || 1;
  return values
    .map((v) => {
      const clamped = Math.min(max, Math.max(min, v));
      const index = Math.round(((clamped - min) / span) * (SPARK_GLYPHS.length - 1));
      return SPARK_GLYPHS[index];
    })
    .join('');
}

/** The exact-text dedupe key for a free-text phrase: lowercased, punctuation stripped, whitespace
 *  collapsed (contract §9). `The menu "re-offers" the same 3 jobs!` and `the menu re offers the same
 *  3 jobs` are one key. This is the right key for the DISTINCTIVENESS tables (`arcNote`,
 *  `quitTrigger`), where the question is literally "did two personas write the same sentence" — and
 *  the wrong one for friction themes, where two personas describing one defect in different words is
 *  the signal ({@link FRICTION_MERGE_THRESHOLD}). */
export function normalizePhrase(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Function words dropped before two friction reports are compared. Standard English function words
 *  only: dropping a DOMAIN word (menu, roll, day) would be a judgement about what the game's
 *  complaints mean, and the whole point of the measure is that it makes no such judgement. */
const FRICTION_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
  'cannot', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'let', 'me', 'more', 'most',
  'must', 'my', 'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our',
  'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your', 'yours', 'yourself',
  'yourselves',
]);

/**
 * The similarity at or above which two friction reports are read as the same complaint.
 *
 * The measure is Dice similarity
 * ({@link frictionSimilarity}) over {@link frictionTokens}: `2 x shared / (|a| + |b|)`, so two reports
 * are merged when roughly 40% of their combined content vocabulary is the same. Dice rather than
 * Jaccard because it is gentler on UNEQUAL lengths (a terse report and a long one about one defect
 * should not be split just because the long one says more), and Dice rather than the
 * overlap/containment coefficient because containment is 1.0 whenever a short report's words are a
 * subset of a long one's, which merges "the menu repeats itself" into any sentence that happens to
 * mention a menu. Under-merging is the safer error here and the whole design leans that way: a
 * wrongly merged theme HIDES a real finding, while a theme left split only under-ranks one.
 *
 * 0.4 is the conservative end of what the real four-persona arc panel supports. On that panel the
 * pairs that should merge sit at 0.417 or above (two reports of the roll-exhaustion defect, worded
 * "0 rolls remaining" and "rollsRemaining at 0"), while the highest-scoring pair that must NOT merge
 * sits at 0.387: the homesteader's roll-exhaustion report against the explorer's location complaint,
 * which share the boilerplate "the work menu offers ..." and nothing else. So 0.4 is deliberately
 * just above a KNOWN false-merge candidate rather than at a round number, and the number to watch if
 * this is ever revisited is that 0.387: drop the threshold below it and the location/thread theme
 * swallows a roll-exhaustion report (at 0.35 it also swallows the soldier's no-combat-option report,
 * making one 6-report theme out of three defects), which is the failure this layer exists to prevent.
 * The cost is visible and accepted: a report that describes a defect with NO vocabulary in common
 * with the rest of its group stays separate, and that is a finding the panel reports rather than
 * papers over — on this panel the homesteader's "the work menu still offered gate options after my
 * rolls were spent" scores only 0.083 to 0.286 against its fellow roll-exhaustion reports (it shares
 * "work menu"/"offered"/"rolls" and nothing else), so the theme counts 3 personas where a human
 * reader counts 4.
 */
export const FRICTION_MERGE_THRESHOLD = 0.4;

/** A crude English suffix stem, applied only to tokens of five characters or more, so `rolls`,
 *  `rolling` and `rolled` collapse onto `roll` and `remaining` onto `remain` — the same complaint
 *  written in another tense should not be a different theme. Deliberately not Porter: a real stemmer
 *  on a 20-word sentence buys almost nothing and hides its rules from the reader. */
function stemToken(word: string): string {
  if (word.length > 4 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * A friction report's content tokens: lowercased, punctuation dropped, function words removed and
 * suffixed stems collapsed ({@link FRICTION_STOPWORDS}, {@link stemToken}).
 *
 * Two splits matter. A camelCase join is undone first, because `rollsRemaining` is ONE token to a
 * plain splitter and that single token is why "rollsRemaining at 0" and "0 rolls remaining" stayed
 * separate themes. Digits stay (a lone `0` is content here: "0 rolls remaining"), while a single
 * letter is dropped as noise.
 */
export function frictionTokens(text: string): Set<string> {
  const spaced = (text ?? '')
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, ' ')
    .replace(/(?<=[A-Za-z])(?=\p{N})|(?<=\p{N})(?=[A-Za-z])/gu, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  const tokens = new Set<string>();
  for (const word of spaced.split(/\s+/)) {
    if (word === '' || FRICTION_STOPWORDS.has(word)) continue;
    if (/^\p{N}+$/u.test(word)) {
      tokens.add(word);
      continue;
    }
    if (word.length < 2) continue;
    tokens.add(stemToken(word));
  }
  return tokens;
}

/** Dice similarity of two token sets: `2 x |A n B| / (|A| + |B|)`, 0 when either side is empty.
 *  Symmetric, so the merge test cannot depend on which report came first. */
export function frictionSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** True when a `building` answer is the prompt's sanctioned "there is nothing" (spec § F). Kept
 *  deliberately narrow: only a `nothing`/`none`/`nil`/`n/a` answer counts, because counting
 *  "no thread yet, but the Warden's charge nags me" as nothing would inflate the very number the
 *  panel treats as a verdict on the long arc. */
export function isNothingAnswer(building: string): boolean {
  const text = normalizePhrase(building);
  return text === '' || /^(nothing|none|nil|n a|na)\b/.test(text);
}

/** How long a run is, and which of its days carry a note. `dayNotes` is the series, so a hole (the
 *  harness's own warning finding) shows here as an unrated day rather than being back-filled — and
 *  the run's own LENGTH comes from the transcript summary, so a lost note cannot shrink it. */
export interface PanelRunLength {
  /** Days the run played: `max(summary.greetings, summary.dayBoundaries)`. `greetings` counts the
   *  day starts, `dayBoundaries` the nightly ticks; a clean N-day run writes N of each, and a run
   *  whose last day ended non-clean (`stalled`/`crashed`/`no-character`) never ticks into the next
   *  day, so it writes N greetings and N-1 boundaries. */
  played: number;
  /** The distinct day numbers that DO have a note, ascending. */
  rated: number[];
  /** Every day in `1..played` with no note. */
  unrated: number[];
}

export function runLength(file: ReviewFile): PanelRunLength {
  const summary = file.summary as Partial<Record<(typeof SUMMARY_COUNTS)[number], number>>;
  const notes = file.dayNotes.map((d) => d.dayNumber).filter((n) => Number.isFinite(n));
  const rated = [...new Set(notes)].sort((a, b) => a - b);
  // The summary is authoritative for how long the run was. The highest rated day is only a FLOOR:
  // a file whose notes outrun its own summary would otherwise be reported as a run shorter than its
  // own series, which is the same lie in the other direction.
  const played = Math.max(summary.greetings ?? 0, summary.dayBoundaries ?? 0, rated[rated.length - 1] ?? 0);
  const has = new Set(rated);
  const unrated: number[] = [];
  for (let day = 1; day <= played; day++) if (!has.has(day)) unrated.push(day);
  return { played, rated, unrated };
}

/**
 * The panel's ONE canonical row order: soonest churn horizon first, ties by persona name. Every
 * section is rendered in it, so row 1 of the score matrix is row 1 of the rubric matrix, the series
 * and the cost table, and a reader can follow a single persona down the whole report. Unreadable
 * horizons sort FIRST ({@link compareQuitHorizons}): a phrase the parser could not read is not
 * evidence of a long horizon, so it must not be shown as the most loyal persona.
 */
export function orderReviews(reviews: readonly ReviewFile[]): ReviewFile[] {
  return [...reviews].sort(
    (a, b) =>
      compareQuitHorizons(parseQuitHorizon(a.review.quitHorizon), parseQuitHorizon(b.review.quitHorizon)) ||
      a.persona.localeCompare(b.persona),
  );
}

export function aggregateComposition(reviews: readonly ReviewFile[]): PanelComposition {
  const byDays = new Map<number, string[]>();
  for (const file of orderReviews(reviews)) {
    const days = runLength(file).played;
    const bucket = byDays.get(days);
    if (bucket) bucket.push(file.persona);
    else byDays.set(days, [file.persona]);
  }
  const shapes: PanelShapeGroup[] = [...byDays.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([days, personas]) => ({
      // One day is the breadth/onboarding shape; anything longer is the arc shape that can speak to
      // decay (spec § G). The interrupted shape is not derivable from a review file — nothing in T5's
      // payload records a skipped stretch — so the panel never guesses at it. Note this label is the
      // run's LENGTH, not its rated days: a five-day run that rated one of them is still an arc run.
      label: days > 1 ? 'arc' : 'breadth',
      personas: personas.length,
      days: personas.map(() => days),
    }));
  return {
    personas: reviews.length,
    shapes,
    personaDays: reviews.reduce((sum, file) => sum + runLength(file).played, 0),
  };
}

export function aggregateRuns(reviews: readonly ReviewFile[]): PanelRunSummary[] {
  return orderReviews(reviews).map((file) => {
    const length = runLength(file);
    return {
      persona: file.persona,
      recordedAt: file.header?.recordedAt ?? null,
      days: length.played,
      rated: length.rated.length,
      unratedDays: length.unrated,
      turns: file.summary.turns,
      outcomes: file.summary.outcomes,
      deadEnds: file.summary.deadEnds,
      findings: { error: file.summary.findings.error, warning: file.summary.findings.warning },
      costCalls: file.cost.totalCalls,
      costTokens: file.cost.totalTokens,
    };
  });
}

/** The score matrix, in {@link orderReviews}'s canonical order (churn horizon, ties by name) — the
 *  order the spec's third benchmark question is actually asked in. */
export function aggregateScores(reviews: readonly ReviewFile[]): PanelScoreRow[] {
  return orderReviews(reviews).map((file) => ({
    persona: file.persona,
    scores: SCORE_DIMENSIONS.reduce(
      (acc, dim) => {
        acc[dim] = file.review.scores[dim];
        return acc;
      },
      {} as Record<ScoreDimension, number>,
    ),
    returnTomorrow: file.review.returnTomorrow,
    hook: file.review.hook.trim(),
    verdict: file.review.verdict,
    quitHorizon: parseQuitHorizon(file.review.quitHorizon),
  }));
}

/** One rubric cell per persona plus the per-criterion mean and coverage. `unobserved` is excluded
 *  from the mean and counted as a gap, which is the whole point of the rule: a criterion no run
 *  could reach must report coverage 0 and NO mean, not a zero and not a NaN (spec § Risks). Rows in
 *  {@link orderReviews}'s canonical order, so row N is the same persona as row N of the matrix. */
export function aggregateRubric(reviews: readonly ReviewFile[]): PanelReport['rubric'] {
  const rows: PanelRubricRow[] = orderReviews(reviews).map((file) => ({
    persona: file.persona,
    values: RUBRIC_CRITERIA.reduce(
      (acc, criterion) => {
        acc[criterion] = file.review.rubric[criterion];
        return acc;
      },
      {} as Record<RubricCriterion, number | 'unobserved'>,
    ),
  }));

  const criteria: RubricCriterionSummary[] = RUBRIC_CRITERIA.map((criterion) => {
    const scored = rows
      .map((row) => row.values[criterion])
      .filter((v): v is number => typeof v === 'number');
    return {
      criterion,
      coverage: scored.length,
      unobserved: rows.length - scored.length,
      mean: scored.length > 0 ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
    };
  });

  return { rows, criteria };
}

/** The per-day engagement/fulfilment series (spec § G), with the arc note each day ended on. Rows in
 *  {@link orderReviews}'s canonical order, and the series is printed in that order so a reader can
 *  follow one persona down the report. */
export function aggregateSeries(reviews: readonly ReviewFile[]): PanelSeriesRow[] {
  return orderReviews(reviews).map((file) => {
    // `buildReviewFile` derives `arcNotes` FROM `dayNotes`, so the two arrays are index-aligned; pair
    // by index before sorting by day, which is the only mapping that survives a file whose notes
    // arrived out of day order.
    const notes = file.dayNotes
      .map((note, i) => ({
        day: note.dayNumber,
        engagement: note.engagement,
        fulfilment: note.fulfilment,
        arcNote: file.arcNotes[i] ?? '',
      }))
      .sort((a, b) => a.day - b.day);
    const engagement = notes.map((n) => n.engagement);
    const fulfilment = notes.map((n) => n.fulfilment);
    const length = runLength(file);
    return {
      persona: file.persona,
      played: length.played,
      days: notes.map((n) => n.day),
      unrated: length.unrated,
      engagement,
      fulfilment,
      engagementSpark: sparkline(engagement),
      fulfilmentSpark: sparkline(fulfilment),
      arcNotes: notes.map((n) => ({ day: n.day, note: n.arcNote.trim() })),
    };
  });
}

/**
 * Friction themes by exposure (contract §9). Reports that make the SAME complaint are grouped into
 * one theme carrying the distinct personas that raised it, the total report count, the worst severity
 * and the tags seen. Dedupe is load-bearing twice over:
 *
 * - nothing caps how often a brain reports a grievance, so without it one persona complaining every
 *   turn would own the ranking on volume alone;
 * - and it has to be by SIMILARITY, not by exact text. Contract §9's rule is that "a friction raised
 *   by one persona is taste; raised by four, or tagged `ritual` by anyone, is a design finding", and
 *   exact text can never see the first half: four personas describing one defect in their own words
 *   produced four once-each themes, so the panel's top finding was invisible as a cross-persona
 *   signal. That is the defect {@link FRICTION_MERGE_THRESHOLD} fixes, on real arc data.
 *
 * Exposure is the SUM over reports of `severity x RECURRENCE_WEIGHT[recurrence]`. The earlier form
 * multiplied the theme's worst severity by its dearest tag by the persona count, which multiplies
 * attributes of DIFFERENT reports: a severity-2 `ritual` from one persona plus a severity-5 `once`
 * from another scored as if a single severity-5 ritual report existed. Severity, tags and persona
 * count stay display columns; only the score is a sum — which is exactly why a merged theme's
 * exposure is the sum of its parts and a 5-report theme correctly outranks 5 themes of one.
 *
 * The representative (`label`) is the first report seen in the panel's canonical order, and the
 * normalised form of it is `theme`. The LONGEST phrasing was rejected as the representative even
 * though it usually carries the most detail: it selects an all-caps report over the identical
 * complaint written normally ("THE MENU RE-OFFERS THE SAME THREE JOBS" is longer than "The menu
 * re-offers the same three jobs!"), and a shouted label reads as emphasis the persona did not
 * intend. First-seen is deterministic, is a real sentence, and keeps the label that exact-text
 * grouping already printed for a theme written one way.
 */
export function aggregateFrictions(reviews: readonly ReviewFile[]): FrictionTheme[] {
  interface Report {
    persona: string;
    dayNumber: number;
    what: string;
    severity: number;
    recurrence: Recurrence;
    tokens: Set<string>;
  }

  // Reports in the panel's canonical order (churn horizon, ties by name), so the first report of a
  // merged theme is deterministic AND `personas` comes out in canonical row order for free.
  const reports: Report[] = [];
  for (const file of orderReviews(reviews)) {
    for (const friction of file.frictions) {
      if (normalizePhrase(friction.what) === '') continue;
      reports.push({
        persona: file.persona,
        dayNumber: friction.dayNumber,
        what: friction.what.trim(),
        severity: friction.severity,
        recurrence: friction.recurrence,
        tokens: frictionTokens(friction.what),
      });
    }
  }

  // Union-find: a merge is transitive (A~B and B~C puts A, B and C in one theme) and the groups are
  // the connected components, which is what lets a middle phrasing pull in two ends that resemble
  // each other less. See FRICTION_MERGE_THRESHOLD for why that is worth the risk and how it is bounded.
  const parent = reports.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // Path compression: a long chain of similar phrasings would otherwise make this quadratic.
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < reports.length; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      const a = reports[i].tokens;
      const b = reports[j].tokens;
      // Dice can never exceed 2 x min(|a|,|b|) / (|a|+|b|), so this arithmetic bound skips most pairs
      // before touching a set: the pairwise pass stays cheap on a panel of hundreds of reports.
      if ((2 * Math.min(a.size, b.size)) / (a.size + b.size) < FRICTION_MERGE_THRESHOLD) continue;
      if (frictionSimilarity(a, b) >= FRICTION_MERGE_THRESHOLD) union(i, j);
    }
  }

  const groups = new Map<number, Report[]>();
  for (let i = 0; i < reports.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(reports[i]);
    else groups.set(root, [reports[i]]);
  }

  const themes: FrictionTheme[] = [...groups.values()].map((group) => {
    let exposure = 0;
    let worstSeverity = 0;
    const personas: string[] = [];
    const recurrences: Recurrence[] = [];
    const seen = new Set<string>();
    for (const report of group) {
      exposure += report.severity * RECURRENCE_WEIGHT[report.recurrence];
      worstSeverity = Math.max(worstSeverity, report.severity);
      if (!recurrences.includes(report.recurrence)) recurrences.push(report.recurrence);
      if (!personas.includes(report.persona)) personas.push(report.persona);
      seen.add(normalizePhrase(report.what));
    }
    const label = group[0].what;
    return {
      theme: normalizePhrase(label),
      label,
      personas,
      personaCount: personas.length,
      count: group.length,
      phrasings: seen.size,
      reports: group.map((r) => ({
        persona: r.persona,
        dayNumber: r.dayNumber,
        what: r.what,
        severity: r.severity,
        recurrence: r.recurrence,
      })),
      worstSeverity,
      recurrences: RECURRENCE_ORDER.filter((r) => recurrences.includes(r)),
      exposure,
      ritual: recurrences.includes('ritual'),
    };
  });

  return themes.sort(
    (a, b) => b.exposure - a.exposure || b.personaCount - a.personaCount || a.label.localeCompare(b.label),
  );
}

/** Split the ranked themes: `ritual`-tagged items stand apart from the rest, because one persona
 *  meeting a defect every session outranks many meeting it once (contract §9). */
export function partitionFrictions(themes: readonly FrictionTheme[]): { ritual: FrictionTheme[]; other: FrictionTheme[] } {
  return {
    ritual: themes.filter((t) => t.ritual),
    other: themes.filter((t) => !t.ritual),
  };
}

/** How many personas could name something they were building, and how many answered `nothing`
 *  (spec § F/§ G). Eight nothings is a verdict on the game's long arc, so the count is promoted into
 *  the panel's header as well as its own section. */
export function aggregateFulfilment(reviews: readonly ReviewFile[]): FulfilmentSignal {
  const named: Array<{ persona: string; building: string }> = [];
  const nothing: string[] = [];
  for (const file of orderReviews(reviews)) {
    if (isNothingAnswer(file.review.building)) nothing.push(file.persona);
    else named.push({ persona: file.persona, building: file.review.building.trim() });
  }
  return { named, nothing, namedCount: named.length, nothingCount: nothing.length };
}

/** The `verbs` histogram, counts by move kind (exact, contract §9). The column set is the union of
 *  the six known kinds and anything else the run recorded, so an unexpected kind is visible rather
 *  than dropped. */
export function aggregateHistogram(reviews: readonly ReviewFile[]): PanelReport['histogram'] {
  const ordered = orderReviews(reviews);
  const extra = new Set<string>();
  for (const file of ordered) {
    for (const kind of Object.keys(file.verbs)) {
      if (!(MOVE_KINDS as readonly string[]).includes(kind)) extra.add(kind);
    }
  }
  const kinds = [...MOVE_KINDS, ...[...extra].sort()];
  const rows: VerbHistogramRow[] = ordered.map((file) => {
    const counts = kinds.reduce(
      (acc, kind) => {
        acc[kind] = file.verbs[kind] ?? 0;
        return acc;
      },
      {} as Record<string, number>,
    );
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      persona: file.persona,
      total,
      kinds: counts,
      freeTextShare: total > 0 ? (counts.custom ?? 0) / total : 0,
    };
  });
  return { kinds, rows };
}

/** The observed label frequency table (contract §9's correction). Reported, never compared against
 *  a vocabulary — see {@link ACTION_VERB_NOTE}. */
export function aggregateActionVerbs(reviews: readonly ReviewFile[]): ActionVerbRow[] {
  return orderReviews(reviews).map((file) => {
    const labels = Object.entries(file.actionVerbs)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return { persona: file.persona, total: labels.reduce((sum, l) => sum + l.count, 0), labels };
  });
}

/** The anti-theatre half that a single run cannot print: across personas, are the arc note and the
 *  quit trigger actually different answers, or the same sentence ten times? Duplicates are reported
 *  by normalised value; a missing arc note is not a duplicate (nothing to compare) but is counted
 *  separately, because a run whose arc never got a note is its own finding. Rows in
 *  {@link orderReviews}'s canonical order; the closing arc note is the LAST entry of the per-day
 *  series the panel prints in its own section (spec § G). */
export function aggregateDistinctiveness(reviews: readonly ReviewFile[]): PanelDistinctiveness {
  const seenArc = new Map<string, string[]>();
  const seenQuit = new Map<string, string[]>();
  const missingArcNotes: string[] = [];

  const rows = orderReviews(reviews).map((file) => {
    const closing = file.arcNotes[file.arcNotes.length - 1] ?? '';
    const arcNote = closing.trim();
    const quitTrigger = file.review.quitTrigger.trim();
    const arcKey = normalizePhrase(arcNote);
    const quitKey = normalizePhrase(quitTrigger);
    if (arcKey === '') missingArcNotes.push(file.persona);
    else seenArc.set(arcKey, [...(seenArc.get(arcKey) ?? []), file.persona]);
    if (quitKey !== '') seenQuit.set(quitKey, [...(seenQuit.get(quitKey) ?? []), file.persona]);
    return {
      persona: file.persona,
      arcNote,
      quitTrigger,
      arcNoteShared: false,
      quitTriggerShared: false,
    };
  });

  const duplicateArcNotes = duplicates(seenArc);
  const duplicateQuitTriggers = duplicates(seenQuit);
  const sharedArc = new Set(duplicateArcNotes.map((d) => d.value));
  const sharedQuit = new Set(duplicateQuitTriggers.map((d) => d.value));
  for (const row of rows) {
    row.arcNoteShared = sharedArc.has(normalizePhrase(row.arcNote));
    row.quitTriggerShared = sharedQuit.has(normalizePhrase(row.quitTrigger));
  }

  return {
    rows,
    distinctArcNotes: seenArc.size,
    distinctQuitTriggers: seenQuit.size,
    duplicateArcNotes,
    duplicateQuitTriggers,
    missingArcNotes,
  };
}

function duplicates(seen: Map<string, string[]>): DistinctivenessDuplicate[] {
  return [...seen.entries()]
    .filter(([, personas]) => personas.length > 1)
    .map(([value, personas]) => ({ value, personas }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

/** Total the per-run LLM spend each review file carries (the `:memory:` DB that held `llm_calls`
 *  died with its run, so this is the only place the panel can read it). Call kinds are merged across
 *  runs with their shares recomputed over the panel, which is the comparison the next panel needs.
 *  Rows in canonical order, like every other section. */
export function aggregateCost(reviews: readonly ReviewFile[]): PanelCost {
  const byKind = new Map<string, { calls: number; tokens: number }>();
  for (const file of reviews) {
    for (const row of file.cost.byCallKind) {
      const entry = byKind.get(row.callKind) ?? { calls: 0, tokens: 0 };
      entry.calls += row.calls;
      entry.tokens += row.tokens;
      byKind.set(row.callKind, entry);
    }
  }
  const totalCalls = reviews.reduce((sum, f) => sum + f.cost.totalCalls, 0);
  const totalTokens = reviews.reduce((sum, f) => sum + f.cost.totalTokens, 0);
  const byCallKind: CallKindBreakdown[] = [...byKind.entries()]
    .map(([callKind, t]) => ({
      callKind,
      calls: t.calls,
      tokens: t.tokens,
      callShare: totalCalls > 0 ? t.calls / totalCalls : 0,
      tokenShare: totalTokens > 0 ? t.tokens / totalTokens : 0,
    }))
    .sort((a, b) => b.calls - a.calls || a.callKind.localeCompare(b.callKind));

  return {
    runs: reviews.length,
    totalCalls,
    totalTokens,
    byCallKind,
    perRun: orderReviews(reviews).map((f) => ({ persona: f.persona, calls: f.cost.totalCalls, tokens: f.cost.totalTokens })),
  };
}

/** Everything the panel reports, from an array of parsed review files and nothing else. */
export function aggregatePanel(reviews: readonly ReviewFile[]): PanelReport {
  if (reviews.length === 0) throw new PanelInputError('no review files to aggregate');
  const themes = aggregateFrictions(reviews);
  // `themes` is EVERY ranked theme and `ritual` marks the tagged subset in place, so a consumer that
  // sums `themes` gets the whole panel; the ritual list is a lens on it, not the other half of a
  // partition that a reader could forget to add back in.
  const { ritual } = partitionFrictions(themes);
  return {
    v: PANEL_FILE_VERSION,
    composition: aggregateComposition(reviews),
    runs: aggregateRuns(reviews),
    scores: aggregateScores(reviews),
    rubric: aggregateRubric(reviews),
    series: aggregateSeries(reviews),
    friction: { themes, ritual, exposureNote: EXPOSURE_NOTE },
    fulfilment: aggregateFulfilment(reviews),
    histogram: aggregateHistogram(reviews),
    actionVerbs: aggregateActionVerbs(reviews),
    distinctiveness: aggregateDistinctiveness(reviews),
    cost: aggregateCost(reviews),
  };
}

// ── Markdown rendering (pure) ────────────────────────────────────────────────────────────────

const cell = (value: string | number): string => String(value).replace(/\|/g, '\\|');

/** A pipe table. Markdown prose in this repo is never hard-wrapped, so neither is a rendered cell. */
function table(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const lines = [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

const mean = (value: number | null): string => (value === null ? '—' : value.toFixed(2));
/** One series cell: the digits AND the glyphs, so the shape is legible without decoding the ramp. */
const seriesCell = (values: readonly number[], glyphs: string): string =>
  values.length === 0 ? '—' : `${values.join(', ')} ${glyphs}`;
const share = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** The opening claim about what shape this panel is, and therefore what it may conclude. */
function shapeIntro(composition: PanelComposition): string {
  const kinds = new Set(composition.shapes.map((s) => s.label));
  if (kinds.size > 1) {
    return 'A mixed panel carries both instruments: the one-day arm is **onboarding** (first-session clarity, the funnel and each persona\'s voice) and the multi-day arm is the **arc** reading (the engagement/fulfilment series and the day the arc note stops growing). The one-day arm cannot speak to the core goal: on day one there is no memory, no co-play and no content exhaustion. Neither arm can speak to a year, because every run holds one player in an eleven-location world. A day-one panel is not a verdict on month three.';
  }
  if (kinds.has('arc')) {
    return 'An arc panel is the **retention instrument**: the engagement/fulfilment series, the day the arc note stops growing, and the content-exhaustion reading a breadth run cannot take. It still cannot speak to co-play or to the year the pitch is about, because every run holds one player in an eleven-location world.';
  }
  return 'A breadth panel is an **onboarding instrument**: it measures the first session, the first-session funnel and each persona\'s voice. It cannot speak to the core goal, because on day one there is no memory, no co-play and no content exhaustion, so most of its rubric cells are `unobserved` by construction. A day-one panel is not a verdict on month three.';
}

/** The shape prose: what the panel is made of, and what its coverage numbers therefore mean. */
function compositionProse(composition: PanelComposition): string {
  const shapes = composition.shapes
    .map((s) => `${s.personas} ${s.label} (${daysEach(s.days[0] ?? 0)})`)
    .join(', ');
  return `This panel is ${composition.personas} persona(s) over ${composition.personaDays} persona-day(s): ${shapes}. Coverage below is the number of personas that could honestly score a criterion, and an \`unobserved\` cell is excluded from the mean rather than scored low: that is what stops a short panel reporting that the game has no aliveness and no memory when it simply had no week three.`;
}

/** The friction table's columns, shared by the ritual list and the rest so the two read alike.
 *  `phrasings` sits beside `reports` on purpose: the two together are what tells a reader whether a
 *  big `reports` number is one persona repeating itself (phrasings 1) or several personas wording one
 *  complaint differently (phrasings > 1), and a merge must never be silent. */
const FRICTION_HEADERS = [
  'theme',
  'personas',
  'reports',
  'phrasings',
  'worst sev',
  'recurrence',
  'exposure',
  'raised by',
];

const daysEach = (days: number): string => `${days} ${days === 1 ? 'day' : 'days'} each`;

/** `days 1-5` when the series is unbroken, the day numbers listed when it is not — a gap in the
 *  series is a finding (the harness warns for a day that closed with no note), and an invented
 *  range would hide it. */
function daysLabel(days: readonly number[]): string {
  if (days.length === 0) return '—';
  if (days.length === 1) return `day ${days[0]}`;
  const contiguous = days.every((d, i) => d === days[0] + i);
  return contiguous ? `days ${days[0]}-${days[days.length - 1]}` : `days ${days.join(', ')}`;
}

/** `3 of 5 days rated (no note: days 4, 5)`. The run's length is the SUMMARY's, and the unrated day
 *  numbers are printed by name: a hole that only shrinks a count is a hole nobody looks at, and a
 *  five-day run that lost a note is still a five-day run. `no days rated` is its own phrase so a run
 *  with no notes at all can never be read as a 0-day breadth run (spec § G). */
function ratedLabel(row: PanelSeriesRow): string {
  const rated = row.played - row.unrated.length;
  const word = row.played === 1 ? 'day' : 'days';
  const base = rated === 0 ? 'no days rated' : `${rated} of ${row.played} ${word} rated`;
  return row.unrated.length > 0 ? `${base} (no note: ${daysLabel(row.unrated)})` : base;
}

/** The whole `panel.md`. Pure: the report in, the markdown out, no clock and no paths. */
export function renderPanelMarkdown(report: PanelReport): string {
  const out: string[] = [];
  out.push('# Agent-player panel');
  out.push('');
  out.push(
    `Aggregated from ${report.cost.runs} persona run(s). Total LLM cost across the panel: ${report.cost.totalCalls} call(s), ${report.cost.totalTokens} token(s).`,
  );
  out.push('');

  // ── What this panel cannot say ──
  out.push('## What this panel cannot say');
  out.push('');
  out.push(shapeIntro(report.composition));
  out.push('');
  out.push(compositionProse(report.composition));
  out.push('');
  out.push(
    `**Fulfilment signal:** ${report.fulfilment.namedCount} of ${report.cost.runs} persona(s) could name something they were building; ${report.fulfilment.nothingCount} answered with nothing. A panel where most personas are building nothing is a verdict on the game's long arc, not on any single day.`,
  );
  out.push('');
  out.push(`**Exposure caveat:** ${report.friction.exposureNote}`);
  out.push('');

  // ── Score matrix ──
  out.push('## Score matrix');
  out.push('');
  out.push(`Ordered by churn horizon, soonest first (${report.scores.length} persona(s)).`);
  out.push('');
  if (report.scores.some((row) => row.quitHorizon.kind === 'unknown')) {
    out.push(
      'Rows whose `quitHorizon` phrase the parser could not read sort FIRST, not last: an unread phrase is not evidence of a long horizon, so it must never be shown as the most committed persona. Those rows print the phrase as the model wrote it.',
    );
    out.push('');
  }
  out.push(
    table(
      [
        'persona',
        'engagement',
        'fulfilment',
        'clarity',
        'challenge',
        'variety',
        'verdict',
        'return tomorrow',
        'quitHorizon',
      ],
      report.scores.map((row) => [
        row.persona,
        row.scores.engagement,
        row.scores.fulfilment,
        row.scores.clarity,
        row.scores.challenge,
        row.scores.variety,
        row.verdict,
        row.returnTomorrow,
        row.quitHorizon.raw === '' ? '(none given)' : row.quitHorizon.raw,
      ]),
    ),
  );
  out.push('');

  // ── Retention signal ──
  out.push('## Retention signal');
  out.push('');
  const tomorrow = (answer: string): number => report.scores.filter((r) => r.returnTomorrow === answer).length;
  out.push(
    `\`returnTomorrow\` is spec § F's first benchmark question and \`hook\` is the answer that goes with it, so both are printed here: ${tomorrow('yes')} said yes, ${tomorrow('probably')} said probably, ${tomorrow('no')} said no. The churn trigger is in the distinctiveness table below — this is the retention half of the same reading, and the panel drops neither.`,
  );
  out.push('');
  out.push(
    table(
      ['persona', 'return tomorrow', 'hook — the one thing that would bring me back'],
      report.scores.map((row) => [row.persona, row.returnTomorrow, row.hook === '' ? '— (none given)' : row.hook]),
    ),
  );
  out.push('');

  // ── Rubric matrix ──
  out.push('## Rubric matrix');
  out.push('');
  out.push(
    '`unobserved` is a first-class answer: it is excluded from the mean and counted as a gap, because a run may not score what it could not have seen.',
  );
  out.push('');
  out.push(
    table(
      ['persona', ...RUBRIC_CRITERIA],
      report.rubric.rows.map((row) => [row.persona, ...RUBRIC_CRITERIA.map((c) => row.values[c])]),
    ),
  );
  out.push('');
  out.push(
    table(
      ['criterion', 'mean', 'coverage', 'unobserved'],
      report.rubric.criteria.map((c) => [
        c.criterion,
        c.coverage === 0 ? '— (nobody could score it)' : mean(c.mean),
        `${c.coverage}/${report.rubric.rows.length}`,
        c.unobserved,
      ]),
    ),
  );
  out.push('');

  // ── Series ──
  out.push('## Engagement and fulfilment series');
  out.push('');
  out.push(
    'Per day, in day order: the numbers first, because a run whose engagement holds at 4 while fulfilment slides 4 to 2 is the shape that predicts churn and it must be legible without decoding a sparkline. The sparkline is the same series mapped onto 1-5. The `days` column lists the rated days (a hole prints its day numbers rather than an invented range) and `rated` counts them against the days the run actually played.',
  );
  out.push('');
  const seriesRows = report.series.map((row) => [
    row.persona,
    daysLabel(row.days),
    ratedLabel(row),
    seriesCell(row.engagement, row.engagementSpark),
    seriesCell(row.fulfilment, row.fulfilmentSpark),
  ]);
  out.push(table(['persona', 'days', 'rated', 'engagement', 'fulfilment'], seriesRows));
  out.push('');
  if (report.series.some((row) => row.played > row.days.length)) {
    out.push(
      'A day with no note is named in the `rated` column and the harness logs a warning finding for it, so a hole cannot pass as a short run: a day that closed unrated was still played.',
    );
    out.push('');
  }
  out.push('### The arc note, day by day');
  out.push('');
  out.push(
    'Spec § G reads *the day the arc note stops growing*: the arc note is what the persona says it is building, rewritten when that changes, so a note that repeats verbatim from one day to the next means the run found nothing new to build. Printed per day, because the closing note alone cannot show WHEN it stopped.',
  );
  out.push('');
  const arcNoteRows = report.series.flatMap((row) =>
    row.arcNotes.map((n) => [row.persona, n.day, n.note === '' ? '—' : n.note]),
  );
  out.push(
    arcNoteRows.length === 0
      ? '_No day notes, so no arc note was recorded._'
      : table(['persona', 'day', 'arcNote'], arcNoteRows),
  );
  out.push('');

  // ── Friction ──
  const { ritual, other } = partitionFrictions(report.friction.themes);
  out.push('## Friction by exposure');
  out.push('');
  out.push(`${ritual.length} ritual theme(s), ${other.length} other theme(s), ${report.friction.themes.length} ranked in all.`);
  out.push('');
  out.push(
    'Exposure is the per-report sum described in the caveat above: each report contributes its own severity times its own tag. `worst sev`, `recurrence` and `personas` are display columns and are never multiplied together.',
  );
  out.push('');
  out.push(
    'Reports that describe ONE defect in different words are merged into a single theme, because the design rule this section exists to apply ("raised by one persona is taste; raised by four is a design finding") is invisible to exact-text grouping. A `phrasings` count above 1 says the theme merged that many distinct wordings, and `panel.json` keeps every contributing report under `friction.themes[].reports`, so a merge is auditable and never hides a report.',
  );
  out.push('');
  const frictionRows = (themes: readonly FrictionTheme[]): (string | number)[][] =>
    themes.map((t) => [
      t.label,
      t.personaCount,
      t.count,
      t.phrasings,
      t.worstSeverity,
      t.recurrences.join('/'),
      t.exposure,
      t.personas.join(', '),
    ]);
  out.push('### Ritual: met every session by someone');
  out.push('');
  out.push(
    'Listed apart from the rest: one persona meeting a defect daily outranks many meeting it once, whatever the individual severity reads.',
  );
  out.push('');
  out.push(
    ritual.length === 0 ? '_None._' : table(FRICTION_HEADERS, frictionRows(ritual)),
  );
  out.push('');
  out.push('### Everything else');
  out.push('');
  out.push(other.length === 0 ? '_None._' : table(FRICTION_HEADERS, frictionRows(other)));
  out.push('');
  // The merge an exact-text grouping would have hidden: named, with every wording it swallowed, so a
  // reader can disagree with the judgement instead of having to trust it.
  const merged = report.friction.themes.filter((t) => t.phrasings > 1);
  if (merged.length > 0) {
    out.push('### Merged phrasings');
    out.push('');
    out.push(
      'Themes that collapsed more than one wording. Every contributing report, with its persona, day, severity and tag, is in `panel.json` under `friction.themes[].reports`; the bullets below are the distinct wordings, in the panel\'s canonical order.',
    );
    out.push('');
    for (const theme of merged) {
      const wordings = new Map<string, FrictionReportRef>();
      for (const row of theme.reports) {
        const key = normalizePhrase(row.what);
        if (!wordings.has(key)) wordings.set(key, row);
      }
      out.push(`- ${theme.count} report(s), ${theme.phrasings} phrasing(s), raised by ${theme.personas.join(', ')}:`);
      for (const row of wordings.values()) out.push(`  - "${row.what}" (${row.persona})`);
    }
    out.push('');
  }

  // ── Fulfilment signal ──
  out.push('## Fulfilment signal');
  out.push('');
  out.push(
    `${report.fulfilment.namedCount} persona(s) named something they were building; **${report.fulfilment.nothingCount} answered with nothing**.`,
  );
  out.push('');
  for (const row of report.fulfilment.named) out.push(`- ${row.persona}: ${row.building}`);
  for (const persona of report.fulfilment.nothing) out.push(`- ${persona}: nothing`);
  out.push('');

  // ── Anti-theatre check ──
  out.push('## Anti-theatre check');
  out.push('');
  out.push('### Move kinds (what the brain chose)');
  out.push('');
  out.push(
    'This is the priors-versus-behaviour comparison: it is exact, and it is the table that says whether the personas are real. The `custom` share is the free-text slot the 2026-09-13 baseline never opened.',
  );
  out.push('');
  out.push(
    table(
      ['persona', 'turns', ...report.histogram.kinds, 'free-text share'],
      report.histogram.rows.map((row) => [
        row.persona,
        row.total,
        ...report.histogram.kinds.map((kind) => row.kinds[kind] ?? 0),
        share(row.freeTextShare),
      ]),
    ),
  );
  out.push('');
  out.push('### Observed action labels (model-authored)');
  out.push('');
  out.push(ACTION_VERB_NOTE);
  out.push('');
  out.push(
    table(
      ['persona', 'labelled actions', 'labels (count)'],
      report.actionVerbs.map((row) => [
        row.persona,
        row.total,
        row.labels.length > 0 ? row.labels.map((l) => `${l.label} ${l.count}`).join(', ') : '—',
      ]),
    ),
  );
  out.push('');
  out.push('### arcNote / quitTrigger distinctiveness');
  out.push('');
  out.push(
    `${report.distinctiveness.distinctArcNotes} distinct closing arc note(s) and ${report.distinctiveness.distinctQuitTriggers} distinct quit trigger(s) across ${report.distinctiveness.rows.length} persona(s). A ✗ marks a value two or more personas produced: the one-piece-of-prose-ten-times failure this table exists to catch.`,
  );
  out.push('');
  out.push(
    table(
      ['persona', 'distinct arcNote', 'closing arcNote', 'distinct quitTrigger', 'quitTrigger'],
      report.distinctiveness.rows.map((row) => [
        row.persona,
        row.arcNoteShared ? '✗ shared' : row.arcNote === '' ? '— none' : '✓ distinct',
        row.arcNote === '' ? '—' : row.arcNote,
        row.quitTriggerShared ? '✗ shared' : '✓ distinct',
        row.quitTrigger,
      ]),
    ),
  );
  out.push('');
  for (const d of report.distinctiveness.duplicateArcNotes) {
    out.push(`- shared arcNote: "${d.value}" (${d.personas.join(', ')})`);
  }
  for (const d of report.distinctiveness.duplicateQuitTriggers) {
    out.push(`- shared quitTrigger: "${d.value}" (${d.personas.join(', ')})`);
  }
  if (report.distinctiveness.missingArcNotes.length > 0) {
    out.push(`- no closing arcNote at all: ${report.distinctiveness.missingArcNotes.join(', ')}`);
  }
  out.push('');

  // ── Runs and cost ──
  out.push('## Runs and cost');
  out.push('');
  out.push(
    table(
      ['persona', 'recordedAt', 'days', 'rated', 'turns', 'outcomes', 'dead-ends', 'warnings', 'errors', 'calls', 'tokens'],
      report.runs.map((r) => [
        r.persona,
        r.recordedAt ?? '—',
        r.days,
        `${r.rated}/${r.days}`,
        r.turns,
        r.outcomes,
        r.deadEnds,
        r.findings.warning,
        r.findings.error,
        r.costCalls,
        r.costTokens,
      ]),
    ),
  );
  out.push('');
  out.push(
    table(
      ['call kind', 'calls', 'call share', 'tokens', 'token share'],
      report.cost.byCallKind.map((c) => [c.callKind, c.calls, share(c.callShare), c.tokens, share(c.tokenShare)]),
    ),
  );
  out.push('');
  return `${out.join('\n')}\n`;
}

// ── File IO (thin) ───────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function require(condition: boolean, source: string, what: string): void {
  if (!condition) throw new PanelInputError(`${source}: ${what}`);
}

/** `require(isRecord(…))` cannot narrow for the compiler, so the callback bodies name their record. */
const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

/** How a bad value reads in an error. A bare `undefined` in a message is indistinguishable from the
 *  literal string `"undefined"` — which is the confusion this boundary exists to stop. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing (the key is missing)';
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return String(value);
}

/** A 1-5 integer — the only form a numeric score cell may take. */
function requireScoreValue(value: unknown, source: string, field: string): number {
  require(
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5,
    source,
    `${field}: expected an integer 1-5, got ${describeValue(value)}`,
  );
  return value as number;
}

/** A rubric cell: the same 1-5 integer, or the exact string `unobserved` (spec § F). A mistyped
 *  `unobserved` is an error rather than a silent hole, because an absent cell and an unobserved one
 *  read alike and only one of them is honest. */
function requireRubricValue(value: unknown, source: string, field: string): RubricValue {
  if (value === 'unobserved') return value;
  require(
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5,
    source,
    `${field}: expected an integer 1-5 or the exact string "unobserved", got ${describeValue(value)}`,
  );
  return value as RubricValue;
}

/** A number the panel adds up or prints as a figure. Not a type nicety: a string in a sum
 *  concatenates (`0` + `"12"`), and a non-finite one prints as `NaN` in a published cell. */
function requireCount(value: unknown, source: string, field: string): number {
  require(
    typeof value === 'number' && Number.isFinite(value),
    source,
    `${field}: expected a number, got ${describeValue(value)}`,
  );
  return value as number;
}

/**
 * Validate one parsed `<AGENT_OUT>.reviews.json` (T5's `buildReviewFile` payload). Every field the
 * panel reads is checked for the shape its use requires, not merely for presence: this boundary is
 * the panel's whole defence against a file it does not understand, and a mistyped cell aggregated
 * anyway becomes a WRONG PUBLISHED NUMBER — a rubric `7` in a 1-5 mean, a `"high"` in a numeric
 * column, a `"four"` in the series, a missing rubric key counted as `unobserved` (which silently
 * drops coverage, the exact reading that rule exists to prevent) or an out-of-vocabulary recurrence
 * scoring 0 and vanishing from the rank. So a bad cell throws, naming the file and the field.
 */
export function parseReviewFile(raw: unknown, source: string): ReviewFile {
  require(isRecord(raw), source, 'not a JSON object');
  const record = raw as Record<string, unknown>;
  require(typeof record.v === 'number', source, 'missing numeric "v" (the reviews-file version)');
  require(
    record.v === REVIEW_FILE_VERSION,
    source,
    `reviews-file version ${String(record.v)} but this panel reads version ${REVIEW_FILE_VERSION}: re-run the persona under the matching agent code`,
  );
  require(typeof record.persona === 'string' && record.persona.length > 0, source, 'missing "persona"');
  require(isRecord(record.review), source, 'missing "review"');
  const review = record.review as Record<string, unknown>;
  require(typeof review.persona === 'string' && review.persona.length > 0, source, 'missing "review.persona"');
  for (const field of ['verdict', 'quitHorizon', 'quitTrigger', 'building', 'hook', 'returnTomorrow'] as const) {
    require(typeof review[field] === 'string', source, `missing "review.${field}"`);
  }

  // The cells: 1-5, or `unobserved` for a criterion the session could not exercise. Required keys,
  // because `undefined` both prints as a cell and counts as a coverage gap.
  require(isRecord(review.rubric), source, 'missing "review.rubric"');
  const rubric = review.rubric as Record<string, unknown>;
  for (const criterion of RUBRIC_CRITERIA) requireRubricValue(rubric[criterion], source, `review.rubric.${criterion}`);
  require(isRecord(review.scores), source, 'missing "review.scores"');
  const scores = review.scores as Record<string, unknown>;
  for (const dimension of SCORE_DIMENSIONS) requireScoreValue(scores[dimension], source, `review.scores.${dimension}`);

  // The run's length comes from these two (`runLength`), so they are load-bearing, not decoration.
  require(isRecord(record.summary), source, 'missing "summary"');
  const summary = record.summary as Record<string, unknown>;
  for (const field of SUMMARY_COUNTS) requireCount(summary[field], source, `summary.${field}`);
  require(isRecord(summary.findings), source, 'missing "summary.findings"');
  const findings = summary.findings as Record<string, unknown>;
  requireCount(findings.error, source, 'summary.findings.error');
  requireCount(findings.warning, source, 'summary.findings.warning');

  require(Array.isArray(record.dayNotes), source, 'missing "dayNotes" array');
  (record.dayNotes as unknown[]).forEach((raw, i) => {
    require(isRecord(raw), source, `dayNotes[${i}]: not an object`);
    const note = asRecord(raw);
    requireCount(note.dayNumber, source, `dayNotes[${i}].dayNumber`);
    requireScoreValue(note.engagement, source, `dayNotes[${i}].engagement`);
    requireScoreValue(note.fulfilment, source, `dayNotes[${i}].fulfilment`);
  });

  require(Array.isArray(record.frictions), source, 'missing "frictions" array');
  (record.frictions as unknown[]).forEach((raw, i) => {
    require(isRecord(raw), source, `frictions[${i}]: not an object`);
    const friction = asRecord(raw);
    require(
      typeof friction.what === 'string',
      source,
      `frictions[${i}].what: expected a string, got ${describeValue(friction.what)}`,
    );
    requireScoreValue(friction.severity, source, `frictions[${i}].severity`);
    require(
      typeof friction.recurrence === 'string' && (RECURRENCE_ORDER as readonly string[]).includes(friction.recurrence),
      source,
      `frictions[${i}].recurrence: expected one of ${RECURRENCE_ORDER.join('|')}, got ${describeValue(friction.recurrence)}`,
    );
  });

  require(Array.isArray(record.arcNotes), source, 'missing "arcNotes" array');
  (record.arcNotes as unknown[]).forEach((note, i) => {
    require(typeof note === 'string', source, `arcNotes[${i}]: expected a string, got ${describeValue(note)}`);
  });

  for (const field of ['verbs', 'actionVerbs'] as const) {
    require(isRecord(record[field]), source, `missing "${field}" object`);
    for (const [key, value] of Object.entries(record[field] as Record<string, unknown>)) {
      requireCount(value, source, `${field}.${key}`);
    }
  }

  require(isRecord(record.cost), source, 'missing "cost"');
  const cost = record.cost as Record<string, unknown>;
  requireCount(cost.totalCalls, source, 'cost.totalCalls');
  requireCount(cost.totalTokens, source, 'cost.totalTokens');

  // SAFETY: every field `ReviewFile` declares and this panel reads has been checked above, in the
  // shape its use requires; the only unchecked keys are ones no consumer of this report touches.
  return raw as unknown as ReviewFile;
}

/** Every `*.reviews.json` in a directory, parsed and version-checked, in filename order. Loud on a
 *  missing/empty directory or an unreadable file (contract §9). */
export function readReviewDirectory(dir: string): ReviewFile[] {
  let names: string[];
  try {
    require(statSync(dir).isDirectory(), dir, 'not a directory');
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.reviews.json'))
      .sort();
  } catch (err) {
    if (err instanceof PanelInputError) throw err;
    throw new PanelInputError(`cannot read directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (names.length === 0) {
    throw new PanelInputError(`${dir}: no *.reviews.json files; a panel is the aggregated output of persona runs, and each run writes one`);
  }

  const reviews: ReviewFile[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const filePath = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new PanelInputError(`cannot read/parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const review = parseReviewFile(parsed, filePath);
    const previous = seen.get(review.persona);
    if (previous !== undefined) {
      // Two files for one persona would double-count every number and silently break the matrix's
      // grouping key, so it is an operator error rather than a sample to merge.
      throw new PanelInputError(
        `${filePath}: persona "${review.persona}" already read from ${previous}; one review file per persona per directory`,
      );
    }
    seen.set(review.persona, filePath);
    reviews.push(review);
  }
  return reviews;
}

/** Write `panel.md` and `panel.json` beside the reviews they were read from. */
export function writePanel(dir: string, report: PanelReport): { markdownPath: string; jsonPath: string } {
  const markdownPath = path.join(dir, PANEL_MARKDOWN_FILE);
  const jsonPath = path.join(dir, PANEL_JSON_FILE);
  writeFileSync(markdownPath, renderPanelMarkdown(report));
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  return { markdownPath, jsonPath };
}

// ── CLI (a thin shell over the functions above; the tests drive those directly) ──

function parseArgs(argv: readonly string[]): { dir?: string; error?: string } {
  let dir: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith('-')) return { error: `unknown flag "${arg}"` };
    if (dir === undefined) dir = arg;
    else return { error: `unexpected argument "${arg}"` };
  }
  return { dir };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const { dir, error } = parseArgs(argv);
  if (error) {
    console.error(`agent:panel: ${error}`);
    return 1;
  }
  if (dir === undefined) {
    console.error('agent:panel: usage: npm run agent:panel -- <dir>   (the directory of <AGENT_OUT>.reviews.json files)');
    return 1;
  }

  let report: PanelReport;
  try {
    const reviews = readReviewDirectory(dir);
    report = aggregatePanel(reviews);
    const { markdownPath, jsonPath } = writePanel(dir, report);
    console.error(`agent:panel: ${dir}`);
    console.error(`  read ${reviews.length} review file(s): ${reviews.map((r) => r.persona).join(', ')}`);
    console.error(`  panel written to ${markdownPath}`);
    console.error(`  panel written to ${jsonPath}`);
  } catch (err) {
    console.error(`agent:panel: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // The aggregate prints its own report: spec § H's "one aggregation step prints one matrix", and the
  // operator reading a panel should not have to cat a file to see what it says.
  console.error(`\n${renderPanelMarkdown(report)}`);
  return 0;
}

// Run only when executed directly (npm run agent:panel) — importing the module in-process (T9's
// panel tests) must not aggregate anything or exit the test process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
