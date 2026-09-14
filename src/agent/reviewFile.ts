/**
 * T5's runner-side views (spec § F, contract §9): what `play.ts` hands the persona reviewer, and what
 * it writes beside the transcript. Two pure functions, no I/O — `play.ts` itself runs `main()` at
 * import, so it is unimportable and untestable, and everything the reviews file needs to be is
 * derived HERE instead.
 *
 * - {@link personaReviewInput} — the reviewer's input, sliced from a finished transcript.
 * - {@link buildReviewFile} — the `<AGENT_OUT>.reviews.json` payload: SELF-SUFFICIENT for T6's panel,
 *   which runs in a different process after the run's `:memory:` DB is long gone and must not have to
 *   re-read the transcript to attribute a persona's numbers.
 * - {@link formatPersonaReview} — the human-readable print, matching the run summary / critique style
 *   `play.ts` already uses on stderr.
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

/** The reviews-file FORMAT version. Bumped when the payload's shape changes incompatibly, so a panel
 *  reading a directory of files can refuse one it does not understand rather than mis-aggregate it.
 *  Not a prompt version: the reviewer's prompt is stamped on its `llm_calls` row
 *  (`agent-critic-v2/persona-review`) and in `review`'s own text only, never here. */
export const REVIEW_FILE_VERSION = 1;

/** The `<AGENT_OUT>.reviews.json` payload (contract §9). Every field is either a whole transcript
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
  /** Counts by `AgentMove.kind` — what the brain chose (contract §9). */
  verbs: Record<string, number>;
  /** Counts by the ENGINE's `distilledType` — what the actions actually were. */
  actionVerbs: Record<string, number>;
  /** The arc note each closed day ended on, in day order — the "did the arc note stop growing" read
   *  (spec § G), derived from `dayNotes` rather than passed in so the two can never disagree. */
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

/** Assemble the reviews file (contract §9). Pure: everything it needs is in the arguments, so a test
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

/** The reviewer's input, sliced from a finished run: the same transcript the critic reads, plus the
 *  distilled series the review is actually about (spec § F/§ E). `dayLogs` is deliberately not
 *  passed — the harness owns TODAY's day log and does not retain it across days, so a runner cannot
 *  reconstruct it without inventing a second definition of a block only the brain ever saw. */
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

/** The review as the operator reads it: one labelled line per field, the same shape as the run
 *  summary and the critique block `play.ts` prints. `unobserved` prints as itself — an absent score
 *  and a low score must not look alike on the terminal. */
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
