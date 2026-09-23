/**
 * The runner-side views `play.ts` hands the persona reviewer: the reviewer's input, the
 * `.reviews.json` payload and the human-readable print — pure, because `play.ts` runs `main()` at import.
 */

import type { LlmCostSummary } from './llmCostSummary.js';
import type { PersonaReview, PersonaReviewInput } from './PlaytestCriticGateway.js';
import type {
  DayNoteEvent,
  FrictionEvent,
  ProtocolEntry,
  ProtocolHeaderEntry,
  ReconEvent,
  Transcript,
  TranscriptSummary,
} from './transcript.js';

/** The reviews-file FORMAT version, bumped when the payload's shape changes incompatibly so a panel
 *  can refuse a file it does not understand. Not a prompt version — that rides the `llm_calls` row. */
export const REVIEW_FILE_VERSION = 1;

/** The `<AGENT_OUT>.reviews.json` payload. Every field is either a whole transcript
 *  value type or a derived slice of one, so the panel needs nothing but this file. */
export interface ReviewFile {
  /** {@link REVIEW_FILE_VERSION}. */
  v: number;
  /** The persona the run played as (`AGENT_PERSONA`), the panel's grouping key. */
  persona: string;
  /** The protocol-log header entry (seq 0): brain class, backend class, `recordedAt` and the header's
   *  own persona stamp. Null only if a caller assembled a file without a protocol log. */
  header: ProtocolHeaderEntry | null;
  summary: TranscriptSummary;
  review: PersonaReview;
  /** The per-day rating series, in day order. */
  dayNotes: DayNoteEvent[];
  /** Every friction the brain reported, in day order. */
  frictions: FrictionEvent[];
  /** Counts by `AgentMove.kind` — what the brain chose. */
  verbs: Record<string, number>;
  /** Counts by the ENGINE's `distilledType` — what the actions actually were. */
  actionVerbs: Record<string, number>;
  /** The arc note each closed day ended on, in day order — the "did the arc note stop growing" read,
   *  derived from `dayNotes` rather than passed in so the two can never disagree. */
  arcNotes: string[];
  /** The run's whole LLM spend (`summarizeLlmCosts`), captured in-process: the `:memory:` DB that
   *  holds it dies with the run. */
  cost: LlmCostSummary;
}

export interface ReviewFileInput {
  persona: string;
  review: PersonaReview;
  transcript: Transcript;
  cost: LlmCostSummary;
}

/** Assemble the reviews file. Pure: everything it needs is in the arguments, so a test
 *  builds the exact payload a live run writes without running one. */
export function buildReviewFile(input: ReviewFileInput): ReviewFile {
  const histogram = input.transcript.verbHistogram();
  const dayNotes = input.transcript.events.filter((e): e is DayNoteEvent => e.type === 'day-note');
  return {
    v: REVIEW_FILE_VERSION,
    persona: input.persona,
    header: protocolHeader(input.transcript.protocol),
    summary: input.transcript.summary(),
    review: input.review,
    dayNotes,
    frictions: input.transcript.events.filter((e): e is FrictionEvent => e.type === 'friction'),
    verbs: histogram.kinds,
    actionVerbs: histogram.verbs,
    arcNotes: dayNotes.map((d) => d.arcNote),
    cost: input.cost,
  };
}

/** The reviewer's input, sliced from a finished run. `dayLogs` is deliberately not passed: the harness
 *  owns today's day log and does not retain it, so a runner cannot reconstruct it without inventing it. */
export function personaReviewInput(persona: string, transcript: Transcript): PersonaReviewInput {
  return {
    persona,
    events: transcript.events,
    summary: transcript.summary(),
    dayNotes: transcript.events.filter((e): e is DayNoteEvent => e.type === 'day-note'),
    frictions: transcript.events.filter((e): e is FrictionEvent => e.type === 'friction'),
    reconScreens: transcript.events.filter((e): e is ReconEvent => e.type === 'recon'),
  };
}

/** The header entry out of a protocol log (seq 0, written by the harness constructor). Scanned
 *  rather than indexed: `protocol[0]` would be an unchecked assertion on the harness's internals. */
function protocolHeader(protocol: readonly ProtocolEntry[]): ProtocolHeaderEntry | null {
  for (const entry of protocol) {
    if (entry.kind === 'header') return entry;
  }
  return null;
}

/** The review as the operator reads it. `unobserved` prints as itself — an absent score and a low
 *  score must not look alike on the terminal. */
export function formatPersonaReview(review: PersonaReview): string {
  const rubric = Object.entries(review.rubric)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const scores = Object.entries(review.scores)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const list = (label: string, items: string[]): string =>
    `  ${label}: ${items.length > 0 ? items.join('; ') : '(none)'}`;
  return [
    `── persona review (${review.persona}) ──`,
    `  rubric:   ${rubric}`,
    `  scores:   ${scores}`,
    `  tomorrow: ${review.returnTomorrow} — verdict: ${review.verdict}`,
    `  hook:     ${review.hook}`,
    `  building: ${review.building}`,
    `  quit:     ${review.quitHorizon} — ${review.quitTrigger}`,
    `  best:     ${review.best}`,
    `  worst:    ${review.worst}`,
    list('engaging', review.engaging),
    list('boring', review.boring),
    list('clunky', review.clunky),
    `  review:   ${review.review}`,
  ].join('\n');
}
