// Production, DeepSeek-backed PipelineLlmGateway (T2, docs/engine/... v12 pipeline plan).
//
// ── Q1: does FallbackLlmGateway (v9) wrap this gateway? ──
//
// Neither. `FallbackLlmGateway` (v9) implements the single-method legacy `LlmGateway` and
// returns a whole-decision divine-intervention on tier-2 — it structurally cannot wrap the
// pipeline's four distinct stage shapes, and wrapping the chain once would require the machine
// to accept a canned full-decision (which its D5b split has no slot for). So the prod pipeline
// gateway is NOT wrapped by `FallbackLlmGateway` at all. Resilience is **structural, owned by
// `PipelineActionStateMachine`**: a `classify` rejection becomes the typed divine-intervention
// outcome in `start()` (`resolveDivineIntervention`, `isDivineIntervention: true`), and since
// 0.3.4 so does any stage failure on beat 1 — see `start()`'s catch. A beat-2+ failure is caught
// one level up, by `WorldEngineImpl.stepActionPipeline`, and resolved as `timed_out`. This gateway
// therefore mirrors `DeepseekLlmGateway`'s single-attempt transport (no internal retry) and still
// throws loudly on transport/parse failure — it just throws a `PipelineStageError`, so those two
// call sites can fail open on an LLM fault without also swallowing an engine fault.
// `FallbackLlmGateway` stays on the v11 path only, deleted with it in T7.

import {
  ACTION_CATEGORIES,
  type ActionCategory,
  type LlmContext,
} from '../LlmGateway.js';
import type { LlmCallRecorder } from '../LlmCallRecorder.js';
import { DeepCapturePolicy } from '../capture-policy.js';
import { buildUserMessage, buildContextDigest, loadPromptSet, type PromptSet } from '../prompt-builder.js';
import { callDeepseek, type DeepseekResponse } from '../deepseek-transport.js';
import { PipelineStageError, isPipelineStageError } from './PipelineStageError.js';
import { buildClassifyUserMessage, buildResolveUserMessage } from './pipeline-messages.js';
import { stripCR, parseStat, parseOptionStat, resolveNpcHandles } from './pipeline-parse.js';
import { stampForPipelineStage, callKindForPipelineStage } from './stamping.js';
import { APP_VERSION } from '../../version.js';
import { c } from '../../util/colors.js';
import type {
  ActionType,
  ClassifyHit,
  PipelineDecideInput,
  PipelineDecideResult,
  PipelineLlmGateway,
  PipelineResolveMutateInput,
  PipelineResolveMutateResult,
  PipelineResolveNarrateInput,
  PipelineResolveNarrateResult,
  PipelineStageResult,
} from './types.js';

export interface ProdPipelineGatewayConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Optional audit sink — records every call attempt. */
  recorder?: LlmCallRecorder;
  /** Injectable prompt set for tests. Defaults to the active `PROMPT_SET_VERSION` set. */
  promptSet?: PromptSet;
  /** If true, console-log a one-line summary per stage (stage label, model, latency, token
   *  usage, response snippet) — mirrors DeepseekLlmGateway's verbose logging. */
  verbose?: boolean;
  /** Governs when raw prompt + reasoning are persisted alongside a call. Defaults to
   *  `new DeepCapturePolicy()` (mode 'spiral', {@link SPIRAL_CHARS_DEFAULT} threshold). */
  capturePolicy?: DeepCapturePolicy;
}

/** Parameters shared by every stage call — the request half of `runStage` below. */
interface StageRequest<T> {
  context: LlmContext;
  systemPrompt: string;
  userMessage: string;
  thinking: boolean;
  stamp: string;
  callKind: string;
  /** Name used in thrown error messages (e.g. 'classify', 'decide'). */
  stageLabel: string;
  /** Parses the JSON-decoded response body into the stage's result type. May throw — a thrown
   *  error here (e.g. an invalid enum value) is treated exactly like a transport/parse failure:
   *  it propagates to the caller and is recorded as a diagnostic (§5's "throws loudly"). */
  parse: (raw: Record<string, unknown>) => T;
}

export class ProdPipelineLlmGateway implements PipelineLlmGateway {
  private apiKey: string;
  private model: string;
  private temperature: number;
  private fetchFn: typeof fetch;
  private recorder?: LlmCallRecorder;
  private promptSet: PromptSet;
  private verbose: boolean;
  private capturePolicy: DeepCapturePolicy;

  constructor(config: ProdPipelineGatewayConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'deepseek-v4-flash';
    this.temperature = config.temperature ?? 0.7;
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.recorder = config.recorder;
    this.promptSet = config.promptSet ?? loadPromptSet();
    this.verbose = config.verbose ?? false;
    this.capturePolicy = config.capturePolicy ?? new DeepCapturePolicy();
  }

  async classify(rawInput: string, context: LlmContext): Promise<PipelineStageResult<ClassifyHit>> {
    const userMessage = buildClassifyUserMessage(rawInput, context);
    return this.runStage({
      context,
      systemPrompt: this.promptSet.classify,
      userMessage,
      thinking: false,
      stamp: stampForPipelineStage('classify'),
      callKind: callKindForPipelineStage('classify'),
      stageLabel: 'classify',
      parse: (raw) => {
        const rawType = raw.actionType ?? raw.action_type;
        if (typeof rawType !== 'string' || !(ACTION_CATEGORIES as readonly string[]).includes(rawType)) {
          throw new Error(`ProdPipelineLlmGateway.classify: invalid or missing actionType (got ${JSON.stringify(rawType)})`);
        }
        const rawFlags = (raw.flags && typeof raw.flags === 'object' ? raw.flags : {}) as Record<string, unknown>;
        return {
          kind: 'hit' as const,
          actionType: rawType as ActionType,
          flags: {
            unsafe_location: Boolean(rawFlags.unsafe_location),
            needs_roll: Boolean(rawFlags.needs_roll),
            target_present: Boolean(rawFlags.target_present),
          },
        };
      },
    });
  }

  async decide(input: PipelineDecideInput): Promise<PipelineStageResult<PipelineDecideResult>> {
    const { actionType, context } = input;
    const hasPrevious = Boolean(context.previousDecisions && context.previousDecisions.length > 0);
    const templates = this.promptSet.decide[actionType as ActionCategory];
    const systemPrompt = hasPrevious ? templates.continue : templates.newAction;
    const userMessage = buildUserMessage(context);

    return this.runStage({
      context,
      systemPrompt,
      userMessage,
      thinking: true,
      stamp: stampForPipelineStage('decide', actionType),
      callKind: callKindForPipelineStage('decide'),
      stageLabel: 'decide',
      parse: (raw) => {
        const distilledType = String(raw.distilledType ?? raw.distilled_type ?? '');
        const stat = parseStat(raw.stat);
        const baseDc = Number(raw.baseDc ?? raw.base_dc ?? 10);
        const required = Boolean(raw.required);
        const decisionOptions = Array.isArray(raw.decision)
          ? raw.decision.map((opt: Record<string, unknown>) => {
              const optStat = parseOptionStat(opt.stat);
              const dcModifier = pickDcModifier(opt);
              return {
                label: stripCR(String(opt.label ?? '')),
                dcModifier,
                ...(optStat ? { stat: optStat } : {}),
              };
            })
          : [];

        const result: PipelineDecideResult = {
          distilledType,
          stat,
          baseDc,
          required,
          decision: decisionOptions,
        };

        if (typeof raw.sceneLocation === 'string' && raw.sceneLocation.trim() !== '') {
          result.sceneLocation = raw.sceneLocation;
        }

        const rawEnemy = raw.combatEnemy as Record<string, unknown> | undefined;
        if (
          rawEnemy && typeof rawEnemy === 'object' &&
          typeof rawEnemy.name === 'string' && rawEnemy.name.trim() !== '' &&
          (rawEnemy.anchor === 'npc' || rawEnemy.anchor === 'location')
        ) {
          result.combatEnemy = { name: rawEnemy.name, anchor: rawEnemy.anchor };
        }

        // decide-scene-narration: the payload is hand-parsed here, not schema-driven, so
        // `narration` needs the same conditional copy as sceneLocation/combatEnemy above or it
        // is silently dropped.
        if (typeof raw.narration === 'string' && raw.narration.trim() !== '') {
          result.narration = raw.narration;
        }

        return result;
      },
    });
  }

  async resolveMutate(input: PipelineResolveMutateInput): Promise<PipelineStageResult<PipelineResolveMutateResult>> {
    const { actionType, verdict, context } = input;
    const systemPrompt = this.promptSet.resolve[actionType as ActionCategory][verdict];
    const userMessage = buildResolveUserMessage(input, 'RESOLVE-MUTATE');

    return this.runStage({
      context,
      systemPrompt,
      userMessage,
      thinking: false,
      stamp: stampForPipelineStage('resolve-mutate', { actionType, verdict }),
      callKind: callKindForPipelineStage('resolve-mutate'),
      stageLabel: 'resolveMutate',
      parse: (raw) => ({
        mutations: Array.isArray(raw.mutations) ? resolveNpcHandles(raw.mutations, context.nearbyNpcs) : [],
      }),
    });
  }

  async resolveNarrate(input: PipelineResolveNarrateInput): Promise<PipelineStageResult<PipelineResolveNarrateResult>> {
    const { actionType, verdict, context } = input;
    const systemPrompt = this.promptSet.resolve[actionType as ActionCategory][verdict];
    const userMessage = buildResolveUserMessage(input, 'RESOLVE-NARRATE');

    return this.runStage({
      context,
      systemPrompt,
      userMessage,
      thinking: false,
      stamp: stampForPipelineStage('resolve-narrate', { actionType, verdict }),
      callKind: callKindForPipelineStage('resolve-narrate'),
      stageLabel: 'resolveNarrate',
      parse: (raw) => ({
        outcomeText: stripCR(String(raw.outcome_text ?? raw.outcomeText ?? '')),
      }),
    });
  }

  /**
   * The one call-shape shared by all four stages (T2 spec steps 1-7): send the request, throw
   * loudly on transport/parse/validation failure (§5 — no retry, no fallback wrapping at this
   * layer), and record ONE audit row in `finally` regardless of outcome. A recorder error is
   * caught + logged, never rethrown (mirrors DeepseekLlmGateway).
   */
  private async runStage<T>(req: StageRequest<T>): Promise<{ result: T; callId: number }> {
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let usage: DeepseekResponse['usage'];
    let finishReason: string | null = null;
    let reasoningContent: string | null = null;
    let content: string | null = null;
    let parseOk = false;
    let errorMsg: string | null = null;
    let result: T | undefined;
    let callId = 0;

    try {
      const res = await callDeepseek({
        apiKey: this.apiKey,
        model: this.model,
        temperature: this.temperature,
        systemPrompt: req.systemPrompt,
        userMessage: req.userMessage,
        thinking: req.thinking,
        fetchFn: this.fetchFn,
      });

      httpStatus = res.httpStatus;
      usage = res.usage;
      finishReason = res.finishReason;
      reasoningContent = res.reasoningContent;

      if (!res.ok) {
        throw new PipelineStageError(
          req.stageLabel,
          'transport',
          `ProdPipelineLlmGateway.${req.stageLabel}: DeepSeek API error ${res.httpStatus}${res.errorText ? `: ${res.errorText}` : ''}`,
        );
      }
      // Whitespace-only counts as empty, not as a parse failure. DeepSeek does occasionally
      // answer 200 with `content: ""`; that used to fall through to `JSON.parse('')` and surface
      // as `failed to parse DeepSeek response:` with nothing after the colon — the one failure
      // mode the message could not describe, and the one the 0.3.3 smoke run actually hit.
      // `finishReason` is carried because it is the only signal that separates a truncated
      // completion ('length') from a genuinely empty one ('stop').
      if (res.content === null || res.content.trim() === '') {
        throw new PipelineStageError(
          req.stageLabel,
          'empty',
          `ProdPipelineLlmGateway.${req.stageLabel}: DeepSeek returned empty response (finishReason=${res.finishReason ?? 'none'})`,
        );
      }
      content = res.content;

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(content);
      } catch (cause) {
        throw new PipelineStageError(
          req.stageLabel,
          'parse',
          `ProdPipelineLlmGateway.${req.stageLabel}: failed to parse DeepSeek response: ${content.slice(0, 200)}`,
          { cause },
        );
      }
      parseOk = true;

      try {
        result = req.parse(raw);
      } catch (cause) {
        // The stage parsers already namespace their own messages, so keep them verbatim and only
        // re-type the throw.
        throw new PipelineStageError(
          req.stageLabel,
          'validation',
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        );
      }

      if (this.verbose) {
        const latencyMs = Date.now() - startedAt;
        const snippet = content.length > 200 ? `${content.slice(0, 200)}…` : content;
        console.log(
          c.cyan(`[pipeline:${req.stageLabel}]`),
          `model=${this.model} latency=${latencyMs}ms tokens=${usage?.total_tokens ?? '?'}`,
          snippet,
        );
      }
    } catch (err) {
      // Everything leaves this stage as a PipelineStageError. What reaches here unwrapped is
      // raised below the envelope — the abort timeout in `deepseek-transport`, or a fetch-level
      // network failure — and both are LLM faults the call sites are entitled to fail open on.
      const wrapped = isPipelineStageError(err) ? err : wrapTransportFailure(req.stageLabel, err);
      errorMsg = wrapped.message;
      // Unconditional (not gated on this.verbose) — mirrors DeepseekLlmGateway's [llm:error] /
      // [llm:parse-error] logging so a failed pipeline stage is never silent in prod.
      if (content !== null) {
        console.error(c.red(`[pipeline:${req.stageLabel}]`), errorMsg, content.slice(0, 500));
      } else {
        console.error(c.red(`[pipeline:${req.stageLabel}]`), errorMsg);
      }
      throw wrapped;
    } finally {
      if (this.recorder) {
        try {
          const reasoningChars = reasoningContent?.length ?? null;
          // Diagnostic = the stage went wrong (transport error or unparseable response); tier is
          // always 0 here (no internal retry, unlike DeepseekLlmGateway's fallback tiers).
          const isDiagnostic = errorMsg !== null || !parseOk;
          const captureDeep = this.capturePolicy.shouldCapture({ diagnostic: isDiagnostic, reasoningChars });
          callId = this.recorder.record({
            appVersion: APP_VERSION,
            promptVersion: req.stamp,
            callKind: req.callKind,
            model: this.model,
            temperature: this.temperature,
            tier: 0,
            playerInput: req.context.rawInput,
            contextDigest: buildContextDigest(req.context),
            responseJson: parseOk ? content : null,
            parseOk,
            validationWarnings: [],
            error: errorMsg,
            httpStatus,
            promptTokens: usage?.prompt_tokens ?? null,
            completionTokens: usage?.completion_tokens ?? null,
            totalTokens: usage?.total_tokens ?? null,
            reasoningChars,
            latencyMs: Date.now() - startedAt,
            finishReason,
            rawPrompt: captureDeep ? req.userMessage : null,
            reasoning: captureDeep ? reasoningContent : null,
            criticSeverity: null,
          });
        } catch (recErr) {
          console.error('[pipeline:audit] failed to record call', recErr);
        }
      }
    }

    if (result === undefined) {
      // Unreachable: the only way to leave the try block is via return (early, removed in v12)
      // or throw — every throw propagates past this line to the caller, so result is always
      // set by the time execution reaches here. Guard exists for compile-time defence against
      // a future refactor adding an early-return before `result` is assigned.
      throw new Error('unreachable: result was never set');
    }
    return { result, callId };
  }
}

/** Re-types a below-the-envelope throw (abort timeout, network failure) as a stage failure. The
 *  original error stays on `cause`, and the abort case keeps its own message so the existing
 *  "timed out" reading of the logs is unchanged. */
function wrapTransportFailure(stageLabel: string, err: unknown): PipelineStageError {
  const e = err as { name?: string; message?: string } | null | undefined;
  const aborted = e?.name === 'AbortError' || (e?.message ?? '').toLowerCase().includes('abort');
  return new PipelineStageError(
    stageLabel,
    aborted ? 'timeout' : 'transport',
    aborted
      ? `ProdPipelineLlmGateway.${stageLabel}: DeepSeek request aborted (timeout)`
      : `ProdPipelineLlmGateway.${stageLabel}: DeepSeek request failed: ${e?.message ?? String(err)}`,
    { cause: err },
  );
}

/** `dcModifier`: prefer camelCase (the v12 JSON contract's spelling); consult snake_case only when
 *  camelCase is absent, so a stray duplicate key can't override the authoritative one. An explicit
 *  `null` on the key actually read means bail and passes through untouched (T2 spec §4) — checked
 *  before defaulting so a `null` isn't swallowed by `??` falling through to 0. */
function pickDcModifier(opt: Record<string, unknown>): number | null {
  const raw = 'dcModifier' in opt ? opt.dcModifier : opt.dc_modifier;
  if (raw === null) return null;
  return Number(raw ?? 0);
}
