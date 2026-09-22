/**
 * Production, OpenRouter-backed `PlaytestCriticGateway` (JSON-seam M4.5). Renders a completed run into
 * a user message, asks the model for a qualitative playtest report, and validates the reply.
 *
 * Mirrors `ProdAgentPlayerGateway` deliberately: reuses `callChatCompletion` verbatim (JSON mode, single
 * attempt, no retry/fallback at this layer), throws loudly on transport/parse/validation failure so
 * the caller sees it, and records ONE `llm_calls` audit row in `finally` regardless of outcome. A
 * recorder error is logged, never rethrown.
 */

import { callChatCompletion, type ChatResponse } from '../llm/chat-transport.js';
import { DEFAULT_LLM_MODEL } from '../llm/openrouter.js';
import type { LlmCallRecorder } from '../llm/LlmCallRecorder.js';
import { APP_VERSION } from '../version.js';
import { c } from '../util/colors.js';
import type {
  CritiqueInput,
  PersonaReview,
  PersonaReviewInput,
  PersonaRubric,
  PersonaScore,
  PersonaScores,
  PlaytestCriticGateway,
  PlaytestReport,
  ReturnTomorrow,
  PersonaVerdict,
  RubricValue,
} from './PlaytestCriticGateway.js';
import type { TranscriptEvent } from './transcript.js';
import { agentCriticStamp, loadCriticTemplate } from './criticPrompt.js';
import { loadPersonaFragment } from './agentPrompt.js';

export interface ProdPlaytestCriticGatewayConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Optional audit sink — records the critique attempt as an `llm_calls` row. */
  recorder?: LlmCallRecorder;
  /** Injectable system prompt for tests. Defaults to the versioned file on disk. */
  systemPrompt?: string;
  /** Injectable BASE for the persona review's system prompt, for tests. The persona's own fragment
   *  is appended to whatever this is (see `composePersonaReviewPrompt`), so a test that injects a
   *  base still exercises the real voice composition. Defaults to `persona-review.md` on disk. */
  personaReviewSystemPrompt?: string;
  /** If true, console-log a one-line summary of the call (model, latency, tokens). */
  verbose?: boolean;
}

/** The shape the critic must return (see critic-v1.md) — the four dimensions plus an overall read. */
interface RawReport {
  pacing?: unknown;
  clarity?: unknown;
  fun?: unknown;
  difficulty?: unknown;
  summary?: unknown;
}

/** The shape a persona review must return (see persona-review.md) — every field optional here so
 *  the VALIDATOR owns what "missing" means, and nothing is silently defaulted. */
interface RawReview {
  persona?: unknown;
  rubric?: unknown;
  scores?: unknown;
  returnTomorrow?: unknown;
  hook?: unknown;
  building?: unknown;
  quitTrigger?: unknown;
  quitHorizon?: unknown;
  engaging?: unknown;
  boring?: unknown;
  clunky?: unknown;
  best?: unknown;
  worst?: unknown;
  verdict?: unknown;
  review?: unknown;
}

const CALL_KIND = 'agent-critic';
/** The persona review gets its own kind: `summarizeLlmCosts` groups by call kind alone, so sharing
 *  `CALL_KIND` would fold a panel's reviews into one merged `agent-critic` row and hide their spend. */
const REVIEW_CALL_KIND = 'agent-persona-review';
const RUBRIC_FIELDS = ['ritualPull', 'visibleStakes', 'somethingToBuild', 'aliveness', 'memory'] as const;
const SCORE_FIELDS = ['engagement', 'fulfilment', 'clarity', 'challenge', 'variety'] as const;
const RETURN_TOMORROW_VALUES: readonly ReturnTomorrow[] = ['yes', 'probably', 'no'];
const VERDICT_VALUES: readonly PersonaVerdict[] = ['would play again tomorrow', 'would drift off', 'would churn'];

/** Compose the persona review's system prompt: the `persona-review.md` template plus the persona's
 *  own fragment (spec § A) — the same fragment the brain played as. That fragment's **Voice** and
 *  **Quit condition** sections are what make ten reviews ten voices rather than one reviewer wearing
 *  ten names; without it every review would answer the third benchmark question from nowhere. */
export function composePersonaReviewPrompt(base: string, persona: string): string {
  return `${base}\n\n${loadPersonaFragment(persona)}`;
}

export class ProdPlaytestCriticGateway implements PlaytestCriticGateway {
  private apiKey: string;
  private model: string;
  private temperature: number;
  private fetchFn: typeof fetch;
  private recorder?: LlmCallRecorder;
  private systemPrompt: string;
  private personaReviewPromptBase: string;
  private verbose: boolean;

  constructor(config: ProdPlaytestCriticGatewayConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_LLM_MODEL;
    // Lower than the brain's 0.7 — this is analysis, not roleplay; steadier, more consistent reads.
    this.temperature = config.temperature ?? 0.4;
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.recorder = config.recorder;
    this.systemPrompt = config.systemPrompt ?? loadCriticTemplate('critic');
    this.personaReviewPromptBase = config.personaReviewSystemPrompt ?? loadCriticTemplate('persona-review');
    this.verbose = config.verbose ?? false;
  }

  async critique(input: CritiqueInput): Promise<PlaytestReport> {
    const userMessage = buildCritiqueMessage(input);
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let usage: ChatResponse['usage'];
    let finishReason: string | null = null;
    let reasoningContent: string | null = null;
    let content: string | null = null;
    let parseOk = false;
    let errorMsg: string | null = null;
    let report: PlaytestReport | undefined;

    try {
      const res = await callChatCompletion({
        apiKey: this.apiKey,
        model: this.model,
        temperature: this.temperature,
        systemPrompt: this.systemPrompt,
        userMessage,
        reasoning: true,
        fetchFn: this.fetchFn,
      });

      httpStatus = res.httpStatus;
      usage = res.usage;
      finishReason = res.finishReason;
      reasoningContent = res.reasoning;

      if (!res.ok) {
        throw new Error(
          `ProdPlaytestCriticGateway: OpenRouter API error ${res.httpStatus}${res.errorText ? `: ${res.errorText}` : ''}`,
        );
      }
      if (res.content === null) {
        throw new Error('ProdPlaytestCriticGateway: OpenRouter returned empty response');
      }
      content = res.content;

      let raw: RawReport;
      try {
        raw = JSON.parse(content) as RawReport;
      } catch {
        throw new Error(`ProdPlaytestCriticGateway: failed to parse OpenRouter response: ${content.slice(0, 200)}`);
      }
      parseOk = true;

      report = resolveReport(raw);

      if (this.verbose) {
        const latencyMs = Date.now() - startedAt;
        console.log(
          c.cyan('[agent:critique]'),
          `model=${this.model} latency=${latencyMs}ms tokens=${usage?.total_tokens ?? '?'}`,
        );
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      if (content !== null) {
        console.error(c.red('[agent:critique]'), errorMsg, content.slice(0, 500));
      } else {
        console.error(c.red('[agent:critique]'), errorMsg);
      }
      throw err;
    } finally {
      if (this.recorder) {
        try {
          this.recorder.record({
            appVersion: APP_VERSION,
            promptVersion: agentCriticStamp('critic'),
            callKind: CALL_KIND,
            model: this.model,
            temperature: this.temperature,
            tier: 0,
            playerInput: `run: ${input.events.length} events, ${input.summary.outcomes} outcomes`,
            contextDigest: JSON.stringify(input.summary),
            responseJson: parseOk ? content : null,
            parseOk,
            validationWarnings: [],
            error: errorMsg,
            httpStatus,
            promptTokens: usage?.prompt_tokens ?? null,
            completionTokens: usage?.completion_tokens ?? null,
            totalTokens: usage?.total_tokens ?? null,
            reasoningChars: reasoningContent?.length ?? null,
            latencyMs: Date.now() - startedAt,
            finishReason,
            rawPrompt: errorMsg !== null || !parseOk ? userMessage : null,
            reasoning: errorMsg !== null || !parseOk ? reasoningContent : null,
            criticSeverity: null,
          });
        } catch (recErr) {
          console.error('[agent:audit] failed to record critique call', recErr);
        }
      }
    }

    if (report === undefined) {
      // Unreachable: the try block leaves only via a return-assigned `report` or a throw that
      // propagates past here. Compile-time defence against a future early return.
      throw new Error('unreachable: report was never set');
    }
    return report;
  }

  /** The persona review (spec § F): the SECOND voice, one model call over a completed run, as the
   *  persona that played it. Structured exactly like `critique` — same transport, same JSON mode,
   *  one `llm_calls` row in `finally`, throws loudly on anything unusable — with its own template and
   *  its own stamp, so the two artefacts are attributable apart. */
  async review(input: PersonaReviewInput): Promise<PersonaReview> {
    const userMessage = buildReviewMessage(input);
    const systemPrompt = composePersonaReviewPrompt(this.personaReviewPromptBase, input.persona);
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let usage: ChatResponse['usage'];
    let finishReason: string | null = null;
    let reasoningContent: string | null = null;
    let content: string | null = null;
    let parseOk = false;
    let errorMsg: string | null = null;
    let review: PersonaReview | undefined;

    try {
      const res = await callChatCompletion({
        apiKey: this.apiKey,
        model: this.model,
        temperature: this.temperature,
        systemPrompt,
        userMessage,
        reasoning: true,
        fetchFn: this.fetchFn,
      });

      httpStatus = res.httpStatus;
      usage = res.usage;
      finishReason = res.finishReason;
      reasoningContent = res.reasoning;

      if (!res.ok) {
        throw new Error(
          `ProdPlaytestCriticGateway: OpenRouter API error ${res.httpStatus}${res.errorText ? `: ${res.errorText}` : ''}`,
        );
      }
      if (res.content === null) {
        throw new Error('ProdPlaytestCriticGateway: OpenRouter returned empty response');
      }
      content = res.content;

      let raw: RawReview;
      try {
        raw = JSON.parse(content) as RawReview;
      } catch {
        throw new Error(`ProdPlaytestCriticGateway: failed to parse OpenRouter response: ${content.slice(0, 200)}`);
      }
      parseOk = true;

      review = resolvePersonaReview(raw);

      if (this.verbose) {
        const latencyMs = Date.now() - startedAt;
        console.log(
          c.cyan('[agent:review]'),
          `persona=${input.persona} model=${this.model} latency=${latencyMs}ms tokens=${usage?.total_tokens ?? '?'}`,
        );
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      if (content !== null) {
        console.error(c.red('[agent:review]'), errorMsg, content.slice(0, 500));
      } else {
        console.error(c.red('[agent:review]'), errorMsg);
      }
      throw err;
    } finally {
      if (this.recorder) {
        try {
          this.recorder.record({
            appVersion: APP_VERSION,
            promptVersion: agentCriticStamp('persona-review'),
            callKind: REVIEW_CALL_KIND,
            model: this.model,
            temperature: this.temperature,
            tier: 0,
            playerInput: `persona ${input.persona}: ${input.events.length} events, ${input.summary.outcomes} outcomes`,
            contextDigest: JSON.stringify(input.summary),
            responseJson: parseOk ? content : null,
            parseOk,
            validationWarnings: [],
            error: errorMsg,
            httpStatus,
            promptTokens: usage?.prompt_tokens ?? null,
            completionTokens: usage?.completion_tokens ?? null,
            totalTokens: usage?.total_tokens ?? null,
            reasoningChars: reasoningContent?.length ?? null,
            latencyMs: Date.now() - startedAt,
            finishReason,
            rawPrompt: errorMsg !== null || !parseOk ? userMessage : null,
            reasoning: errorMsg !== null || !parseOk ? reasoningContent : null,
            criticSeverity: null,
          });
        } catch (recErr) {
          console.error('[agent:audit] failed to record persona-review call', recErr);
        }
      }
    }

    if (review === undefined) {
      // Unreachable, as in `critique` — defence against a future early return slipping through.
      throw new Error('unreachable: persona review was never set');
    }
    return review;
  }
}

/** Validate the critic's `{ pacing, clarity, fun, difficulty, summary }` reply. Throws loudly if any
 *  dimension is missing or blank — the same "fail visibly" contract as the brain's move parse. */
function resolveReport(raw: RawReport): PlaytestReport {
  const fields = ['pacing', 'clarity', 'fun', 'difficulty', 'summary'] as const;
  const out = {} as PlaytestReport;
  for (const f of fields) {
    const v = raw[f];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`ProdPlaytestCriticGateway: report field "${f}" is missing or empty`);
    }
    out[f] = v.trim();
  }
  return out;
}

/**
 * Validate a persona review's reply against the spec's § F JSON block. EVERY field is required and
 * every closed vocabulary is checked: this is the measurement itself, so a missing field, a string
 * where a number belongs, a rubric value outside 1..5 and `'unobserved'`, or a `returnTomorrow`
 * outside `yes|probably|no` throws rather than being dropped or defaulted. A silently dropped cell
 * would read in the panel exactly like a criterion nobody had an opinion about, which is the one
 * failure mode the `unobserved` rule exists to prevent. Text is trimmed; the closed vocabularies are
 * normalised first (case, spacing, a trailing sentence stop), so `"would  drift off."` is read
 * rather than thrown away over punctuation.
 *
 * Exported for the prompt-agreement test: `tests/agent/persona-review.test.ts` round-trips the
 * prompt's own JSON block through this resolver, so a prompt edit that drops or moves a field
 * breaks the suite rather than a paid run.
 */
export function resolvePersonaReview(raw: RawReview): PersonaReview {
  if (!isRecord(raw.rubric)) {
    throw new Error('ProdPlaytestCriticGateway: review field "rubric" is missing or not an object');
  }
  if (!isRecord(raw.scores)) {
    throw new Error('ProdPlaytestCriticGateway: review field "scores" is missing or not an object');
  }

  const rubric = {} as PersonaRubric;
  for (const field of RUBRIC_FIELDS) rubric[field] = rubricValue(raw.rubric[field], field);

  const scores = {} as PersonaScores;
  for (const field of SCORE_FIELDS) scores[field] = scoreValue(raw.scores[field], field);

  const persona = requireText(raw.persona, 'persona').toLowerCase();
  const returnTomorrow = requireVocab(raw.returnTomorrow, 'returnTomorrow', RETURN_TOMORROW_VALUES);
  const verdict = requireVocab(raw.verdict, 'verdict', VERDICT_VALUES);

  return {
    persona,
    rubric,
    scores,
    returnTomorrow,
    hook: requireText(raw.hook, 'hook'),
    building: requireText(raw.building, 'building'),
    quitTrigger: requireText(raw.quitTrigger, 'quitTrigger'),
    // Free text on purpose: the prompt constrains the SHAPE, and the panel buckets what it gets
    // with `parseQuitHorizon`. Rejecting an unparseable phrasing here would throw away a whole paid
    // run over a wording, and the panel can still sequence an `unknown` honestly.
    quitHorizon: requireText(raw.quitHorizon, 'quitHorizon'),
    engaging: requireTextList(raw.engaging, 'engaging'),
    boring: requireTextList(raw.boring, 'boring'),
    clunky: requireTextList(raw.clunky, 'clunky'),
    best: requireText(raw.best, 'best'),
    worst: requireText(raw.worst, 'worst'),
    verdict,
    review: requireText(raw.review, 'review'),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One rubric cell: an integer 1..5 or the exact string `unobserved`. */
function rubricValue(v: unknown, field: string): RubricValue {
  if (v === 'unobserved') return 'unobserved';
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5) return v as RubricValue;
  throw new Error(
    `ProdPlaytestCriticGateway: rubric value "${field}" is ${JSON.stringify(v)} — expected an integer 1..5 or "unobserved"`,
  );
}

/** One session score: an integer 1..5. `unobserved` is a RUBRIC answer only — all five scored
 *  dimensions rate the session, so a session always had a chance to score them. */
function scoreValue(v: unknown, field: string): PersonaScore {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5) return v as PersonaScore;
  throw new Error(
    `ProdPlaytestCriticGateway: score "${field}" is ${JSON.stringify(v)} — expected an integer 1..5`,
  );
}

/** A required non-blank string, trimmed. */
function requireText(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`ProdPlaytestCriticGateway: review field "${field}" is missing or empty`);
  }
  return v.trim();
}

/** A required array of non-blank strings. An EMPTY array is a legitimate answer ("nothing was
 *  boring"); a non-string member is a mistyped field and throws. */
function requireTextList(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) {
    throw new Error(`ProdPlaytestCriticGateway: review field "${field}" is missing or not an array`);
  }
  return v.map((item, i) => requireText(item, `${field}[${i}]`));
}

/** One of a closed vocabulary. Normalised first — lowercased, whitespace-collapsed, and a trailing
 *  sentence stop dropped — so `"Would  play again tomorrow."` is read rather than treated as a
 *  different answer. The word still has to be the right one: only a different WORD is a hard failure. */
function requireVocab<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  const norm = typeof v === 'string' ? v.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,;:!]+$/, '').trim() : '';
  if ((allowed as readonly string[]).includes(norm)) return norm as T;
  throw new Error(
    `ProdPlaytestCriticGateway: review field "${field}" is ${JSON.stringify(v)} — expected one of ${allowed.map((a) => `"${a}"`).join(', ')}`,
  );
}

/** The completed run rendered as the critic's user message: the scoreboard, then the play log in order. Kept
 *  a free function (not a method) so tests can assert the exact wire text. */
export function buildCritiqueMessage(input: CritiqueInput): string {
  return [
    'RUN SUMMARY:',
    JSON.stringify(input.summary),
    '',
    'PLAY LOG:',
    input.events.map(renderEvent).join('\n'),
  ].join('\n');
}

/** One transcript event as a single readable log line the critic reads. */
function renderEvent(e: TranscriptEvent): string {
  switch (e.type) {
    case 'turn':
      return `[${e.screen}] ${oneLine(e.text)}\n    → chose ${JSON.stringify(e.chosen)} (offered: ${e.offered.join(', ')})`;
    case 'outcome':
      return `OUTCOME: ${oneLine(e.text)}`;
    case 'commute':
      return `COMMUTE → ${e.destination}`;
    case 'dead-end':
      return `DEAD-END: ${e.reason}${e.detail ? ` (${oneLine(e.detail)})` : ''}`;
    case 'day':
      return `── NIGHT → day ${e.dayNumber}: ${e.note} ──`;
    case 'finding':
      return `⚠ FINDING [${e.severity}]: ${e.summary}${e.detail ? ` (${oneLine(e.detail)})` : ''}`;
    case 'greeting':
      return `👋 ${oneLine(e.text)}`;
    case 'recon':
      return `RECON /${e.screen}: ${oneLine(e.text)}`;
    case 'friction':
      return `FRICTION [severity ${e.severity}, ${e.recurrence}]: ${oneLine(e.what)}`;
    case 'day-note':
      return `DAY NOTE → day ${e.dayNumber}: engagement ${e.engagement}, fulfilment ${e.fulfilment} — ${oneLine(e.line)}`;
  }
}

/** Collapse a multi-line screen render to a single log line — the critic reads the shape of play,
 *  not the ANSI framing, and a flat line keeps the log scannable. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The completed run rendered for the PERSONA REVIEWER (spec § F): the scoreboard, then the distilled
 * series the reviewer is actually asked to judge — the per-day rating pair, the frictions with their
 * recurrence, the recon screens it consulted — and finally the play log in order. The series come
 * first on purpose: the review's whole job is the shape across days, and last week's play log is
 * exactly the detail the per-day note exists to spare the reviewer (spec § Risks, context).
 *
 * A series the run did not produce is printed as `(none)` rather than dropped: an absent section
 * would read as "the harness forgot", and a reviewer that cannot tell "no frictions" from "frictions
 * withheld" would write a confident review of its own blind spot.
 */
export function buildReviewMessage(input: PersonaReviewInput): string {
  const lines: string[] = ['RUN SUMMARY:', JSON.stringify(input.summary), ''];

  lines.push('DAY NOTES (engagement / fulfilment / the line / the arc note):');
  lines.push(
    ...(input.dayNotes.length > 0
      ? input.dayNotes.map(
          (d) =>
            `  day ${d.dayNumber}: ${d.engagement} / ${d.fulfilment} — ${oneLine(d.line)} (arc: ${oneLine(d.arcNote)})`,
        )
      : ['  (none reported)']),
  );
  lines.push('');

  lines.push('FRICTIONS (severity, recurrence, what):');
  lines.push(
    ...(input.frictions.length > 0
      ? input.frictions.map((f) => `  day ${f.dayNumber}: ${f.severity}, ${f.recurrence} — ${oneLine(f.what)}`)
      : ['  (none reported)']),
  );
  lines.push('');

  lines.push('RECON SCREENS CONSULTED:');
  lines.push(
    ...(input.reconScreens.length > 0
      ? input.reconScreens.map((r) => `  /${r.screen}: ${oneLine(r.text)}`)
      : ['  (none)']),
  );
  lines.push('');

  if (input.dayLogs && input.dayLogs.length > 0) {
    lines.push('DAY LOGS:');
    lines.push(...input.dayLogs.map((log) => `  ${oneLine(log)}`));
    lines.push('');
  }

  lines.push('PLAY LOG:', input.events.map(renderEvent).join('\n'));
  return lines.join('\n');
}
