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
import { compareQuitHorizons, parseQuitHorizon, type PersonaVerdict, type QuitHorizon } from './PlaytestCriticGateway.js';
import type { Recurrence } from './AgentPlayerGateway.js';
import type { CallKindBreakdown } from './llmCostSummary.js';

/** The `panel.json` FORMAT version. Bumped when the aggregated shape changes incompatibly, so a
 *  later comparison against the 2026-09-13 baseline can refuse a report it cannot read rather than
 *  diff two different things. Not tied to {@link REVIEW_FILE_VERSION}: this is the panel's own
 *  output, and the panel can be re-run from the same review files at any time. */
export const PANEL_FILE_VERSION = 1;

/** The panel's two file outputs, written beside the reviews it reads. */
export const PANEL_MARKDOWN_FILE = 'panel.md';
export const PANEL_JSON_FILE = 'panel.json';

/**
 * Projected exposure per reported friction over a six-month campaign (contract §9): how many
 * sessions a player is expected to meet it in. `once` is trivia, `periodic` reads as roughly
 * fortnightly, `ritual` as every single session — this is the documented ASSUMPTION behind the
 * ranking, not a measurement, and the weights are the whole reason a single persona meeting a
 * defect daily (1 × 180 × 1) outranks the entire panel meeting it once (5 × 1 × 10).
 */
export const RECURRENCE_WEIGHT: Record<Recurrence, number> = { once: 1, periodic: 13, ritual: 180 };

/** The tag order used wherever recurrences are listed, cheapest first. */
export const RECURRENCE_ORDER: readonly Recurrence[] = ['once', 'periodic', 'ritual'];

/** One line in the panel's own header, so the numbers below are read as relative to the assumption. */
export const EXPOSURE_NOTE =
  'Exposure = worst severity x the dearest recurrence tag seen x personas reporting the theme, ' +
  'over a six-month campaign at RECURRENCE_WEIGHT { once 1, periodic 13, ritual 180 }. It is an ' +
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
  /** Days each of them played, in persona order. */
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
  days: number;
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
  returnTomorrow: string;
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
  days: number[];
  engagement: number[];
  fulfilment: number[];
  engagementSpark: string;
  fulfilmentSpark: string;
}

export interface FrictionTheme {
  /** The normalised grouping key (lowercased, whitespace-collapsed, punctuation-stripped). */
  theme: string;
  /** The display form: the first `what` seen for this theme, trimmed. */
  label: string;
  /** Distinct personas that reported it, in review order. */
  personas: string[];
  personaCount: number;
  /** Total reports, one per friction event — a persona reporting it five times counts five here
   *  and once in {@link personaCount}, which is what stops one grievance dominating the ranking. */
  count: number;
  worstSeverity: number;
  /** The tags seen, cheapest first. */
  recurrences: Recurrence[];
  exposure: number;
  /** True when ANY report carried the `ritual` tag: met every session by someone is a design
   *  finding, so these are listed apart from the rest however mild the individual reports read. */
  ritual: boolean;
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
  friction: { themes: FrictionTheme[]; ritual: FrictionTheme[]; exposureNote: string };
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

/** The dedupe key for a free-text phrase: lowercased, punctuation stripped, whitespace collapsed
 *  (contract §9). `The menu "re-offers" the same 3 jobs!` and `the menu re offers the same 3 jobs`
 *  are one theme; nothing smarter is attempted, because a linguistic merge would be a judgement the
 *  panel cannot defend. */
export function normalizePhrase(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when a `building` answer is the prompt's sanctioned "there is nothing" (spec § F). Kept
 *  deliberately narrow: only a `nothing`/`none`/`nil`/`n/a` answer counts, because counting
 *  "no thread yet, but the Warden's charge nags me" as nothing would inflate the very number the
 *  panel treats as a verdict on the long arc. */
export function isNothingAnswer(building: string): boolean {
  const text = normalizePhrase(building);
  return text === '' || /^(nothing|none|nil|n a|na)\b/.test(text);
}

/** How many days a run actually rated. `dayNotes` is the series, so a hole (the harness's own
 *  warning finding) shows as a missing day here rather than being back-filled. */
function runDays(file: ReviewFile): number {
  const days = file.dayNotes.map((d) => d.dayNumber).filter((n) => Number.isFinite(n));
  return days.length > 0 ? Math.max(...days) : 0;
}

export function aggregateComposition(reviews: readonly ReviewFile[]): PanelComposition {
  const byDays = new Map<number, string[]>();
  for (const file of reviews) {
    const days = runDays(file);
    const bucket = byDays.get(days);
    if (bucket) bucket.push(file.persona);
    else byDays.set(days, [file.persona]);
  }
  const shapes: PanelShapeGroup[] = [...byDays.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([days, personas]) => ({
      // One day is the breadth/onboarding shape; anything longer is the arc shape that can speak to
      // decay (spec § G). The interrupted shape is not derivable from a review file — nothing in T5's
      // payload records a skipped stretch — so the panel never guesses at it.
      label: days > 1 ? 'arc' : 'breadth',
      personas: personas.length,
      days: personas.map(() => days),
    }));
  return {
    personas: reviews.length,
    shapes,
    personaDays: reviews.reduce((sum, file) => sum + runDays(file), 0),
  };
}

export function aggregateRuns(reviews: readonly ReviewFile[]): PanelRunSummary[] {
  return reviews.map((file) => ({
    persona: file.persona,
    recordedAt: file.header?.recordedAt ?? null,
    days: runDays(file),
    turns: file.summary.turns,
    outcomes: file.summary.outcomes,
    deadEnds: file.summary.deadEnds,
    findings: { error: file.summary.findings.error, warning: file.summary.findings.warning },
    costCalls: file.cost.totalCalls,
    costTokens: file.cost.totalTokens,
  }));
}

/** The score matrix, ordered by churn horizon so the panel reads as "who leaves first" — the order
 *  the spec's third benchmark question is actually asked in. Ties fall back to the persona name so
 *  the report is stable run to run. */
export function aggregateScores(reviews: readonly ReviewFile[]): PanelScoreRow[] {
  return reviews
    .map((file) => ({
      persona: file.persona,
      scores: SCORE_DIMENSIONS.reduce(
        (acc, dim) => {
          acc[dim] = file.review.scores[dim];
          return acc;
        },
        {} as Record<ScoreDimension, number>,
      ),
      returnTomorrow: file.review.returnTomorrow,
      verdict: file.review.verdict,
      quitHorizon: parseQuitHorizon(file.review.quitHorizon),
    }))
    .sort((a, b) => compareQuitHorizons(a.quitHorizon, b.quitHorizon) || a.persona.localeCompare(b.persona));
}

/** One rubric cell per persona plus the per-criterion mean and coverage. `unobserved` is excluded
 *  from the mean and counted as a gap, which is the whole point of the rule: a criterion no run
 *  could reach must report coverage 0 and NO mean, not a zero and not a NaN (spec § Risks). */
export function aggregateRubric(reviews: readonly ReviewFile[]): PanelReport['rubric'] {
  const rows: PanelRubricRow[] = reviews.map((file) => ({
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

/** The per-day engagement/fulfilment series (spec § G). Rows in run order; the caller prints them
 *  in that order so a reader can follow one persona down the report. */
export function aggregateSeries(reviews: readonly ReviewFile[]): PanelSeriesRow[] {
  return reviews.map((file) => {
    const notes = [...file.dayNotes].sort((a, b) => a.dayNumber - b.dayNumber);
    const engagement = notes.map((n) => n.engagement);
    const fulfilment = notes.map((n) => n.fulfilment);
    return {
      persona: file.persona,
      days: notes.map((n) => n.dayNumber),
      engagement,
      fulfilment,
      engagementSpark: sparkline(engagement),
      fulfilmentSpark: sparkline(fulfilment),
    };
  });
}

/**
 * Friction themes by exposure (contract §9). Every report of the same normalised `what` collapses
 * into one theme carrying the distinct personas that raised it, the total report count, the worst
 * severity and the tags seen. Dedupe is load-bearing: nothing caps how often a brain reports a
 * grievance, so without it one persona complaining every turn would own the ranking on volume
 * alone. Ordering is exposure descending, ties by persona count then label, so the report is
 * deterministic.
 */
export function aggregateFrictions(reviews: readonly ReviewFile[]): FrictionTheme[] {
  const themes = new Map<string, FrictionTheme>();
  for (const file of reviews) {
    for (const friction of file.frictions) {
      const theme = normalizePhrase(friction.what);
      if (theme === '') continue;
      let entry = themes.get(theme);
      if (!entry) {
        entry = {
          theme,
          label: friction.what.trim(),
          personas: [],
          personaCount: 0,
          count: 0,
          worstSeverity: 0,
          recurrences: [],
          exposure: 0,
          ritual: false,
        };
        themes.set(theme, entry);
      }
      entry.count += 1;
      entry.worstSeverity = Math.max(entry.worstSeverity, friction.severity);
      if (!entry.recurrences.includes(friction.recurrence)) entry.recurrences.push(friction.recurrence);
      if (friction.recurrence === 'ritual') entry.ritual = true;
      if (!entry.personas.includes(file.persona)) entry.personas.push(file.persona);
    }
  }

  for (const entry of themes.values()) {
    entry.personaCount = entry.personas.length;
    entry.recurrences = RECURRENCE_ORDER.filter((r) => entry.recurrences.includes(r));
    const dearest = entry.recurrences.reduce((max, r) => Math.max(max, RECURRENCE_WEIGHT[r]), 0);
    entry.exposure = entry.worstSeverity * dearest * entry.personaCount;
  }

  return [...themes.values()].sort(
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
  for (const file of reviews) {
    if (isNothingAnswer(file.review.building)) nothing.push(file.persona);
    else named.push({ persona: file.persona, building: file.review.building.trim() });
  }
  return { named, nothing, namedCount: named.length, nothingCount: nothing.length };
}

/** The `verbs` histogram, counts by move kind (exact, contract §9). The column set is the union of
 *  the six known kinds and anything else the run recorded, so an unexpected kind is visible rather
 *  than dropped. */
export function aggregateHistogram(reviews: readonly ReviewFile[]): PanelReport['histogram'] {
  const extra = new Set<string>();
  for (const file of reviews) {
    for (const kind of Object.keys(file.verbs)) {
      if (!(MOVE_KINDS as readonly string[]).includes(kind)) extra.add(kind);
    }
  }
  const kinds = [...MOVE_KINDS, ...[...extra].sort()];
  const rows: VerbHistogramRow[] = reviews.map((file) => {
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
  return reviews.map((file) => {
    const labels = Object.entries(file.actionVerbs)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return { persona: file.persona, total: labels.reduce((sum, l) => sum + l.count, 0), labels };
  });
}

/** The anti-theatre half that a single run cannot print: across personas, are the arc note and the
 *  quit trigger actually different answers, or the same sentence ten times? Duplicates are reported
 *  by normalised value; a missing arc note is not a duplicate (nothing to compare) but is counted
 *  separately, because a run whose arc never got a note is its own finding. */
export function aggregateDistinctiveness(reviews: readonly ReviewFile[]): PanelDistinctiveness {
  const seenArc = new Map<string, string[]>();
  const seenQuit = new Map<string, string[]>();
  const missingArcNotes: string[] = [];

  const rows = reviews.map((file) => {
    const arcNote = (file.arcNotes[file.arcNotes.length - 1] ?? '').trim();
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
 *  runs with their shares recomputed over the panel, which is the comparison the next panel needs. */
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
    perRun: reviews.map((f) => ({ persona: f.persona, calls: f.cost.totalCalls, tokens: f.cost.totalTokens })),
  };
}

/** Everything the panel reports, from an array of parsed review files and nothing else. */
export function aggregatePanel(reviews: readonly ReviewFile[]): PanelReport {
  if (reviews.length === 0) throw new PanelInputError('no review files to aggregate');
  const themes = aggregateFrictions(reviews);
  const { ritual, other } = partitionFrictions(themes);
  return {
    v: PANEL_FILE_VERSION,
    composition: aggregateComposition(reviews),
    runs: aggregateRuns(reviews),
    scores: aggregateScores(reviews),
    rubric: aggregateRubric(reviews),
    series: aggregateSeries(reviews),
    friction: { themes: other, ritual, exposureNote: EXPOSURE_NOTE },
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

/** The friction table's columns, shared by the ritual list and the rest so the two read alike. */
const FRICTION_HEADERS = ['theme', 'personas', 'reports', 'worst sev', 'recurrence', 'exposure', 'raised by'];

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
  out.push(
    table(
      ['persona', 'engagement', 'fulfilment', 'clarity', 'challenge', 'variety', 'verdict', 'quitHorizon'],
      report.scores.map((row) => [
        row.persona,
        row.scores.engagement,
        row.scores.fulfilment,
        row.scores.clarity,
        row.scores.challenge,
        row.scores.variety,
        row.verdict,
        row.quitHorizon.raw === '' ? '(none given)' : row.quitHorizon.raw,
      ]),
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
    'Per day, in day order: the numbers first, because a run whose engagement holds at 4 while fulfilment slides 4 to 2 is the shape that predicts churn and it must be legible without decoding a sparkline. The sparkline is the same series mapped onto 1-5.',
  );
  out.push('');
  const seriesRows = report.series.map((row) => [
    row.persona,
    daysLabel(row.days),
    seriesCell(row.engagement, row.engagementSpark),
    seriesCell(row.fulfilment, row.fulfilmentSpark),
  ]);
  out.push(table(['persona', 'days', 'engagement', 'fulfilment'], seriesRows));
  out.push('');
  if (report.series.some((row) => row.days.length === 0)) {
    out.push(
      'A `—` means the run wrote no day note at all: the harness logs a warning finding for a day that closed with no note, so that hole is visible in the run itself, not only here.',
    );
    out.push('');
  }

  // ── Friction ──
  out.push('## Friction by exposure');
  out.push('');
  out.push(`${report.friction.ritual.length} ritual theme(s), ${report.friction.themes.length} other theme(s).`);
  out.push('');
  const frictionRows = (themes: readonly FrictionTheme[]): (string | number)[][] =>
    themes.map((t) => [
      t.label,
      t.personaCount,
      t.count,
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
    report.friction.ritual.length === 0
      ? '_None._'
      : table(FRICTION_HEADERS, frictionRows(report.friction.ritual)),
  );
  out.push('');
  out.push('### Everything else');
  out.push('');
  out.push(
    report.friction.themes.length === 0
      ? '_None._'
      : table(FRICTION_HEADERS, frictionRows(report.friction.themes)),
  );
  out.push('');

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
      ['persona', 'recordedAt', 'days', 'turns', 'outcomes', 'dead-ends', 'warnings', 'errors', 'calls', 'tokens'],
      report.runs.map((r) => [
        r.persona,
        r.recordedAt ?? '—',
        r.days,
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

/**
 * Validate one parsed `<AGENT_OUT>.reviews.json` (T5's `buildReviewFile` payload). Only the fields the
 * panel actually reads are checked, plus the version: a file this panel does not understand must stop
 * the panel rather than be aggregated into a wrong number.
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
  require(isRecord(review.rubric), source, 'missing "review.rubric"');
  require(isRecord(review.scores), source, 'missing "review.scores"');
  require(typeof review.verdict === 'string', source, 'missing "review.verdict"');
  require(typeof review.quitHorizon === 'string', source, 'missing "review.quitHorizon"');
  require(typeof review.quitTrigger === 'string', source, 'missing "review.quitTrigger"');
  require(typeof review.building === 'string', source, 'missing "review.building"');
  require(isRecord(record.summary), source, 'missing "summary"');
  require(Array.isArray(record.dayNotes), source, 'missing "dayNotes" array');
  require(Array.isArray(record.frictions), source, 'missing "frictions" array');
  require(Array.isArray(record.arcNotes), source, 'missing "arcNotes" array');
  require(isRecord(record.verbs), source, 'missing "verbs" object');
  require(isRecord(record.actionVerbs), source, 'missing "actionVerbs" object');
  require(isRecord(record.cost), source, 'missing "cost"');
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
