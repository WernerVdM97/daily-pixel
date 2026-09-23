import type {
  CritiqueInput,
  PersonaReview,
  PersonaReviewInput,
  PlaytestCriticGateway,
  PlaytestReport,
} from './PlaytestCriticGateway.js';

/**
 * Deterministic, network-free `PlaytestCriticGateway` for tests + CI, the critic's counterpart to
 * `ScriptedAgentPlayerGateway`: a fixed report, and every input recorded for a test to assert on.
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
 * The canned review a scripted run gets: the criteria a scripted session cannot have exercised are
 * `unobserved` rather than scored low, and a cleverer fixture would invent the measurement.
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
