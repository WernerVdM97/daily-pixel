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
// outcome in `start()` (`resolveDivineIntervention`, `isDivineIntervention: true`); a
// `decide`/`resolveMutate`/`resolveNarrate` throw propagates up by design (the machine
// deliberately does not catch them — see `PipelineScriptedGateway`'s header). This gateway
// therefore mirrors `DeepseekLlmGateway`'s single-attempt transport (no internal retry) and
// throws loudly on transport/parse failure. `FallbackLlmGateway` stays on the v11 path only,
// deleted with it in T7. (How `WorldEngineImpl` handles a propagated pipeline throw at the live
// call site is T6's concern, not this gateway's.)

import {
  ACTION_CATEGORIES,
  type ActionCategory,
  type LlmContext,
} from '../LlmGateway.js';
import type { LlmCallRecorder } from '../LlmCallRecorder.js';
import { buildUserMessage, buildContextDigest, loadPromptSet, type PromptSet } from '../prompt-builder.js';
import { callDeepseek, type DeepseekResponse } from '../deepseek-transport.js';
import { buildClassifyUserMessage, buildResolveUserMessage } from './pipeline-messages.js';
import { stripCR, parseStat, parseOptionStat, resolveNpcHandles } from './pipeline-parse.js';
import { stampForPipelineStage, callKindForPipelineStage } from './stamping.js';
import { APP_VERSION } from '../../version.js';
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
  /** Injectable prompt set for tests. Defaults to `loadPromptSet('v12')`. */
  promptSet?: PromptSet;
  /** If true, this gateway currently has no verbose logging of its own (unlike
   *  DeepseekLlmGateway) — accepted for shape-parity with that config and future use. */
  verbose?: boolean;
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

  constructor(config: ProdPipelineGatewayConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'deepseek-v4-flash';
    this.temperature = config.temperature ?? 0.7;
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.recorder = config.recorder;
    this.promptSet = config.promptSet ?? loadPromptSet('v12');
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
          typeof rawEnemy.name === 'string' &&
          (rawEnemy.anchor === 'npc' || rawEnemy.anchor === 'location')
        ) {
          result.combatEnemy = { name: rawEnemy.name, anchor: rawEnemy.anchor };
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
        throw new Error(
          `ProdPipelineLlmGateway.${req.stageLabel}: DeepSeek API error ${res.httpStatus}${res.errorText ? `: ${res.errorText}` : ''}`,
        );
      }
      if (res.content === null) {
        throw new Error(`ProdPipelineLlmGateway.${req.stageLabel}: DeepSeek returned empty response`);
      }
      content = res.content;

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(content);
      } catch {
        throw new Error(`ProdPipelineLlmGateway.${req.stageLabel}: failed to parse DeepSeek response: ${content.slice(0, 200)}`);
      }
      parseOk = true;

      result = req.parse(raw);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (this.recorder) {
        try {
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
            reasoningChars: reasoningContent?.length ?? null,
            latencyMs: Date.now() - startedAt,
            finishReason,
            rawPrompt: (errorMsg !== null || !parseOk || process.env.LLM_LOG_ALL_PROMPTS === '1') ? req.userMessage : null,
            reasoning: (errorMsg !== null || !parseOk || process.env.LLM_LOG_ALL_PROMPTS === '1') ? reasoningContent : null,
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

/** `dcModifier`: prefer camelCase (the v12 JSON contract's spelling); consult snake_case only when
 *  camelCase is absent, so a stray duplicate key can't override the authoritative one. An explicit
 *  `null` on the key actually read means bail and passes through untouched (T2 spec §4) — checked
 *  before defaulting so a `null` isn't swallowed by `??` falling through to 0. */
function pickDcModifier(opt: Record<string, unknown>): number | null {
  const raw = 'dcModifier' in opt ? opt.dcModifier : opt.dc_modifier;
  if (raw === null) return null;
  return Number(raw ?? 0);
}
