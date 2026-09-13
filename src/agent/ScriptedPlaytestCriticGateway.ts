import type {
  CritiqueInput,
  PersonaReview,
  PersonaReviewInput,
  PlaytestCriticGateway,
  PlaytestReport,
} from './PlaytestCriticGateway.js';

/**
 * Deterministic, network-free `PlaytestCriticGateway` for tests + CI (JSON-seam M4.5) — the
 * critic's counterpart to `ScriptedAgentPlayerGateway`. Returns a fixed `PlaytestReport` and
 * records every input it was handed, so a test can drive the full feedback plumbing (render →
 * critique → report) and assert on what the critic actually read, with no LLM call.
 *
 * It is also the persona review's stub (T5): `review()` returns a constructed `PersonaReview` and
 * records its input the same way. Without a review of its constructor's own, the gateway answers in
 * a canned single-day voice — the honest shape for a scripted run, with the two criteria a session
 * cannot reach marked `unobserved` rather than scored low (spec § Risks).
 */
export class ScriptedPlaytestCriticGateway implements PlaytestCriticGateway {
  /** Every input the critic was handed, in call order — for assertions on what it read. */
  readonly calls: CritiqueInput[] = [];

  /** Every persona-review input, in call order. */
  readonly reviewCalls: PersonaReviewInput[] = [];

  constructor(
    private readonly report: PlaytestReport,
    /** The review this stub returns. Defaults to {@link scriptedPersonaReview} for the persona it
     *  is asked about, so the CI path needs no fixture and still carries the persona it played as. */
    private readonly fixedReview?: PersonaReview,
  ) {}

  async critique(input: CritiqueInput): Promise<PlaytestReport> {
    this.calls.push(input);
    return this.report;
  }

  async review(input: PersonaReviewInput): Promise<PersonaReview> {
    this.reviewCalls.push(input);
    return this.fixedReview ?? scriptedPersonaReview(input.persona);
  }
}

/**
 * The canned review a scripted run gets. A scripted harness run plays no dice and no content, so the
 * two criteria it cannot have exercised — `aliveness` (the world moving without you is a week-3
 * event by design) and `memory` (nothing has had time to be remembered) — are `unobserved`, and the
 * rest sit at the middle of the scale. Anything cleverer here would be the test fixture inventing
 * the measurement it is meant to carry through the plumbing.
 */
export function scriptedPersonaReview(persona: string): PersonaReview {
  return {
    persona,
    rubric: {
      ritualPull: 3,
      visibleStakes: 3,
      somethingToBuild: 3,
      aliveness: 'unobserved',
      memory: 'unobserved',
    },
    scores: { engagement: 3, fulfilment: 3, clarity: 3, challenge: 3, variety: 3 },
    returnTomorrow: 'probably',
    hook: 'a scripted run reports no specific hook',
    building: 'a scripted run reports no specific arc',
    quitTrigger: 'nothing in a scripted run could stop a player playing',
    quitHorizon: 'never on this evidence',
    engaging: ['the scripted beats complete'],
    boring: [],
    clunky: [],
    best: 'the scripted day completing',
    worst: 'the scripted day completing',
    verdict: 'would drift off',
    review: 'A scripted run wrote nothing worth reviewing; this review exists to carry the plumbing.',
  };
}
