// Source: https://api-docs.deepseek.com/ — OpenAI-compatible API
// Chat completions: POST /chat/completions with Bearer auth
// JSON mode: response_format: { type: "json_object" } — https://api-docs.deepseek.com/guides/json_mode

import type {
  LlmGateway,
  LlmContext,
  LlmDecision,
  CartographerGateway,
  CartographerInput,
  CartographerResult,
  RecapGateway,
  RecapActionInput,
  RecapResult,
} from './LlmGateway.js';
import type { LlmCallRecorder } from './LlmCallRecorder.js';
import { buildSystemPrompt, buildUserMessage, buildContextDigest, PROMPT_VERSION } from './prompt-builder.js';
import { APP_VERSION } from '../version.js';
import { c } from '../util/colors.js';

export interface DeepseekConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** If true, log all LLM request/response data to console. */
  verbose?: boolean;
  /** Optional audit sink — records every call attempt (success, failure, retry). */
  recorder?: LlmCallRecorder;
  /**
   * If true, persist the full LLM reasoning (thinking) on EVERY call, not just
   * diagnostic/failed ones. POC toggle via LOG_LLM_THINKING_ALL — costs DB space.
   */
  logThinkingAll?: boolean;
}

/** System prompt for the D3 cartographer — a tiny, focused world-builder. */
const CARTOGRAPHER_SYSTEM_PROMPT = `You are the cartographer for The Warden's Oak, a dark-fantasy text RPG. A player's action just took them to a place that is NOT yet on the map, so a provisional entry was created. Your job is to chart it.

You are given the NEW place's name, the list of ALREADY-KNOWN locations, and the narrative that led the player there.

Decide:
- Is this genuinely a NEW place, or is the new name just a synonym for one already in the known list (e.g. "The Temple" for "The Shrine of the First Flame")? If it is a duplicate, set "matchesExisting" to the EXACT existing name.
- Is it safe (a settlement, sanctuary, indoors-with-people) or wild (wilderness, ruins, open road, anywhere danger roams)? Off-map places are usually wild.
- Write a vivid one-paragraph description (2-3 sentences) in the game's grim tone that fits the narrative and the name.

Return ONLY valid JSON, no markdown fences:
{
  "matchesExisting": "<exact existing name, or omit if genuinely new>",
  "is_safe": 0 or 1,
  "description": "<2-3 sentence description>"
}`;

/** System prompt for the weekly recap — a terse, evocative chronicler. */
const RECAP_SYSTEM_PROMPT = `You are the chronicler of The Warden's Oak, a dark-fantasy text RPG. You are given a JSON list of the past week's resolved player actions (character, type, outcome, narrative). Write the week's chronicle.

Judge what MATTERS. Ignore bland, routine, or failed-to-nothing actions (idle waiting, fruitless searches, ordinary day-work with no consequence). Favour: deaths and near-deaths, victories and defeats, discoveries, arrivals at new places, wealth or power swings, anything that moves a character's story.

Return ONLY valid JSON, no markdown fences:
{
  "digest": "<2-4 sentences, world-level, weaving the week's arc across characters; grim, terse, evocative. If nothing notable happened, say so in one wry line.>",
  "highlights": ["<one short line per notable beat, lead with the character name>", "..."]
}

Keep "highlights" to at most 12 lines, most significant first. Use only events present in the data — never invent.`;

export class DeepseekLlmGateway implements LlmGateway, CartographerGateway, RecapGateway {
  private apiKey: string;
  private model: string;
  private temperature: number;
  private fetchFn: typeof fetch;
  private verbose: boolean;
  private recorder?: LlmCallRecorder;
  private logThinkingAll: boolean;

  constructor(config: DeepseekConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'deepseek-v4-flash';
    this.temperature = config.temperature ?? 0.7;
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.verbose = config.verbose ?? false;
    this.recorder = config.recorder;
    this.logThinkingAll = config.logThinkingAll ?? false;
  }

  async decide(context: LlmContext): Promise<LlmDecision> {
    // Audit fields, populated as the call progresses; recorded in `finally` so
    // failures and retries are captured, not just the happy path.
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    let finishReason: string | null = null;
    let reasoningChars: number | null = null;
    let responseJson: string | null = null;
    let parseOk = false;
    let warnings: string[] = [];
    let errorMsg: string | null = null;
    let rawPrompt: string | null = null;
    let reasoning: string | null = null;
    let decision: LlmDecision | undefined;

    try {
      decision = await this.runDecision(context, (fields) => {
        httpStatus = fields.httpStatus ?? httpStatus;
        usage = fields.usage ?? usage;
        finishReason = fields.finishReason ?? finishReason;
        reasoningChars = fields.reasoningChars ?? reasoningChars;
        responseJson = fields.responseJson ?? responseJson;
        parseOk = fields.parseOk ?? parseOk;
        warnings = fields.warnings ?? warnings;
        rawPrompt = fields.rawPrompt ?? rawPrompt;
        reasoning = fields.reasoning ?? reasoning;
      });
      return decision;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (this.recorder) {
        try {
          // "Diagnostic" = the LLM call itself went wrong: a transport error, an
          // empty/unparseable (malformed-format) response, or a fallback retry.
          // Raw prompt + thinking are always captured for these.
          const isDiagnostic = (context.attemptTier ?? 0) > 0 || errorMsg !== null || !parseOk;
          // Thinking on every OTHER (well-formed) call is opt-in via the env toggle.
          const captureReasoning = isDiagnostic || this.logThinkingAll;
          const callId = this.recorder.record({
            appVersion: APP_VERSION,
            promptVersion: PROMPT_VERSION,
            model: this.model,
            temperature: this.temperature,
            tier: context.attemptTier ?? 0,
            playerInput: context.rawInput,
            contextDigest: buildContextDigest(context),
            rawPrompt: isDiagnostic ? rawPrompt : null,
            reasoning: captureReasoning ? reasoning : null,
            responseJson,
            parseOk,
            validationWarnings: warnings,
            error: errorMsg,
            httpStatus,
            promptTokens: usage?.prompt_tokens ?? null,
            completionTokens: usage?.completion_tokens ?? null,
            totalTokens: usage?.total_tokens ?? null,
            reasoningChars,
            latencyMs: Date.now() - startedAt,
            finishReason,
          });
          if (decision) decision._llmCallId = callId;
        } catch (recErr) {
          // Audit must never break gameplay.
          console.error(c.red('[llm:audit] failed to record call'), recErr);
        }
      }
    }
  }

  /** Performs the actual request/parse; reports audit fields via `onProgress`. */
  private async runDecision(
    context: LlmContext,
    onProgress: (fields: {
      httpStatus?: number;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      finishReason?: string | null;
      reasoningChars?: number | null;
      responseJson?: string | null;
      parseOk?: boolean;
      warnings?: string[];
      rawPrompt?: string | null;
      reasoning?: string | null;
    }) => void,
  ): Promise<LlmDecision> {
    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(context);
    // Report the prompt up front so it's captured even if the request throws.
    onProgress({ rawPrompt: userMessage });

    const requestBody = {
      model: this.model,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userMessage },
      ],
      response_format: { type: 'json_object' as const },
      thinking: { type: 'enabled' as const },
      temperature: this.temperature,
      stream: false,
    };

    if (this.verbose) {
      console.log(c.cyan('[llm:request]'), JSON.stringify(requestBody, null, 2));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await this.fetchFn('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    onProgress({ httpStatus: response.status });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(c.red('[llm:error]'), response.status, errText);
      throw new Error(`DeepSeek API error ${response.status}: ${errText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string; reasoning_content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const reasoningContent = data.choices?.[0]?.message?.reasoning_content ?? null;
    onProgress({
      usage: data.usage,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      reasoningChars: reasoningContent?.length ?? null,
      reasoning: reasoningContent,
    });

    const msg = data.choices?.[0]?.message;
    const content = msg?.content;
    if (!content) {
      throw new Error('DeepSeek returned empty response');
    }

    if (this.verbose) {
      if (msg?.reasoning_content) {
        console.log(c.magenta('[llm:thoughts]'), msg.reasoning_content);
      }
      console.log(c.cyan('[llm:response:raw]'), content);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error(c.red('[llm:parse-error]'), content.slice(0, 500));
      throw new Error(`Failed to parse DeepSeek response: ${content.slice(0, 200)}`);
    }
    onProgress({ responseJson: content, parseOk: true });

    if (this.verbose) {
      console.log(c.green('[llm:parsed]'), JSON.stringify(parsed, null, 2));
    }

    const decision = this.parseDecision(parsed);
    onProgress({ warnings: this.validateDecision(parsed, decision) });

    // D1: reject a completely empty turn — no options to choose, no mutations, no
    // outcome text. There is nothing to resolve and nothing to decide, so surfacing
    // it would burn a roll on a dead turn. Throw so the fallback gateway retries
    // (and, failing that, hands the player divine intervention) instead.
    if (
      decision.decision.length === 0 &&
      decision.mutations === undefined &&
      decision.outcomeText === undefined
    ) {
      throw new Error(
        'DeepSeek returned an empty turn (no decision, no mutations, no outcome_text) — nothing to resolve',
      );
    }

    return decision;
  }

  /**
   * D3 cartographer call — reuses the same HTTP transport as `decide`, with a
   * tiny focused prompt and structured schema. Best-effort: never throws on a
   * parse/transport failure (returns an empty result so the caller leaves the
   * provisional row as-is). Not audited via the decision recorder — it is a
   * separate, off-critical-path concern.
   */
  async enrich(input: CartographerInput): Promise<CartographerResult> {
    const userMessage = [
      `NEW LOCATION NAME: ${input.newName}`,
      `KNOWN LOCATIONS: ${input.existingNames.join(', ') || 'none'}`,
      `NARRATIVE: ${input.narrative || '(none given)'}`,
    ].join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.fetchFn('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system' as const, content: CARTOGRAPHER_SYSTEM_PROMPT },
            { role: 'user' as const, content: userMessage },
          ],
          response_format: { type: 'json_object' as const },
          temperature: this.temperature,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn(c.yellow('[cartographer] non-200'), response.status);
        return {};
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return {};

      const parsed = JSON.parse(content) as Record<string, unknown>;
      const result: CartographerResult = {};
      if (typeof parsed.matchesExisting === 'string' && parsed.matchesExisting.trim() !== '') {
        result.matchesExisting = parsed.matchesExisting.trim();
      }
      if (parsed.is_safe === 0 || parsed.is_safe === 1) {
        result.is_safe = parsed.is_safe;
      } else if (typeof parsed.is_safe === 'boolean') {
        result.is_safe = parsed.is_safe ? 1 : 0;
      }
      if (typeof parsed.description === 'string' && parsed.description.trim() !== '') {
        result.description = stripCR(parsed.description.trim());
      }
      return result;
    } catch (err) {
      console.warn(c.yellow('[cartographer] enrich failed'), err instanceof Error ? err.message : String(err));
      return {};
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Weekly recap call — reuses the same HTTP transport, with the chronicler
   * prompt and a JSON schema. Throws on transport/parse failure so the caller's
   * deterministic fallback header takes over (the recap must never block the
   * Monday beat). Not audited via the decision recorder — a reporting concern.
   */
  async summarizeWeek(actions: RecapActionInput[]): Promise<RecapResult> {
    const userMessage = JSON.stringify(actions);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await this.fetchFn('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system' as const, content: RECAP_SYSTEM_PROMPT },
            { role: 'user' as const, content: userMessage },
          ],
          response_format: { type: 'json_object' as const },
          temperature: this.temperature,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`recap non-200: ${response.status}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('recap returned empty content');

      const parsed = JSON.parse(content) as Record<string, unknown>;
      const digest = typeof parsed.digest === 'string' ? stripCR(parsed.digest.trim()) : '';
      const highlights = Array.isArray(parsed.highlights)
        ? parsed.highlights
            .filter((h): h is string => typeof h === 'string' && h.trim() !== '')
            .map((h) => stripCR(h.trim()))
        : [];
      if (digest === '' && highlights.length === 0) {
        throw new Error('recap had no digest and no highlights');
      }
      return { digest, highlights };
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseDecision(raw: Record<string, unknown>): LlmDecision {
    const decision: LlmDecision = {
      ...(raw.prompt === undefined ? {} : { prompt: stripCR(String(raw.prompt)) }),
      distilledType: String(raw.distilled_type ?? ''),
      stat: this.parseStat(raw.stat),
      baseDc: Number(raw.base_dc ?? 10),
      required: Boolean(raw.required),
      done: Boolean(raw.done),
      decision: Array.isArray(raw.decision)
        ? raw.decision.map((opt: Record<string, unknown>) => {
            const optStat = this.parseOptionStat(opt.stat);
            return {
              label: stripCR(String(opt.label ?? '')),
              dcModifier: opt.dc_modifier === null ? null : Number(opt.dc_modifier ?? 0),
              // Only attach when the LLM supplied a valid stat — keeps the common
              // (no-override) option shape exactly { label, dcModifier }.
              ...(optStat ? { stat: optStat } : {}),
            };
          })
        : [],
      ...(raw.mutations === undefined ? {} : { mutations: raw.mutations as unknown[] }),
      ...(raw.outcome_text === undefined ? {} : { outcomeText: stripCR(String(raw.outcome_text)) }),
    };

    return decision;
  }

  /** Returns human-readable warnings about the decision; also logs them. */
  private validateDecision(raw: Record<string, unknown>, d: LlmDecision): string[] {
    const warnings: string[] = [];

    if (!d.distilledType) warnings.push('distilled_type is empty');

    const validStats = ['physical', 'wisdom', 'intelligence', 'charisma'];
    if (!validStats.includes(d.stat)) {
      warnings.push(`stat "${d.stat}" is not one of ${validStats.join('/')} (raw: ${JSON.stringify(raw.stat)})`);
    }

    if (d.baseDc < 10 || d.baseDc > 18) {
      warnings.push(`base_dc ${d.baseDc} is outside expected range 10-18`);
    }

    if (!Array.isArray(raw.decision)) {
      warnings.push('decision is not an array');
    } else if (d.decision.length === 0 && d.mutations === undefined && d.outcomeText === undefined) {
      // Empty `decision` is the prompt's "resolve outright" signal (v7+ dropped
      // the `done` flag), so it's only a problem when there's nothing to resolve
      // WITH — no mutations and no outcome_text.
      warnings.push('decision array is empty with no mutations or outcome_text — nothing to resolve and no options');
    } else if (d.decision.length > 0) {
      for (let i = 0; i < d.decision.length; i++) {
        const opt = d.decision[i];
        if (!opt.label) {
          const rawOpt = (raw.decision as Array<Record<string, unknown>>)[i];
          const hasText = !!rawOpt?.text || !!rawOpt?.name;
          warnings.push(`option[${i}] has empty label` +
            (hasText ? ` — LLM used "${rawOpt?.text || rawOpt?.name}" instead of "label"` : ''));
        }
        if (opt.dcModifier !== null && (opt.dcModifier < -5 || opt.dcModifier > 5)) {
          warnings.push(`option[${i}] dc_modifier ${opt.dcModifier} is outside range -5 to +5`);
        }
        const rawOptStat = (raw.decision as Array<Record<string, unknown>>)[i]?.stat;
        if (rawOptStat != null && !validStats.includes(String(rawOptStat))) {
          warnings.push(`option[${i}] stat "${String(rawOptStat)}" is not one of ${validStats.join('/')} — ignored, inheriting action stat`);
        }
      }
    }

    if (warnings.length > 0) {
      console.warn(c.yellow('[llm:validate]'), warnings.join('; '));
      console.warn(c.yellow('[llm:validate] raw response:'), JSON.stringify(raw).slice(0, 500));
    }

    // Rule 4b: a resolving turn — the v8 signal is an empty `decision` array, with
    // the legacy `done` flag honoured as a backstop (E3) — whose mutations are only
    // negative stamina/health with no reward. On a SUCCESS that reads as a failure
    // reward. Kept as a quality warning under the settled contract.
    const isResolving = d.done || d.decision.length === 0;
    if (isResolving && Array.isArray(raw.mutations) && raw.mutations.length > 0) {
      const hasReward = (raw.mutations as Array<Record<string, unknown>>).some(m => {
        if (!m || typeof m !== 'object') return false;
        const type = String(m.type ?? '');
        if (['add_item', 'spawn_npc', 'set_location'].includes(type)) return true;
        if (['modify_wealth', 'modify_rolls_remaining'].includes(type)) return Number(m.amount ?? 0) > 0;
        return false;
      });
      if (!hasReward) {
        const allNegative = (raw.mutations as Array<Record<string, unknown>>).every(m => {
          if (!m || typeof m !== 'object') return false;
          const type = String(m.type ?? '');
          return ['modify_stamina', 'modify_health'].includes(type) && Number(m.amount ?? 0) < 0;
        });
        if (allNegative) {
          warnings.push('resolving turn with only negative stamina/health mutations — a SUCCESS must include a reward (prompt rule 4b)');
        }
      }
    }

    // Check mutations is an array when present
    if (raw.mutations !== undefined && !Array.isArray(raw.mutations)) {
      warnings.push(`mutations is not an array (${typeof raw.mutations})`);
      console.warn(c.yellow('[llm:validate] mutations is not an array:'), typeof raw.mutations, JSON.stringify(raw.mutations).slice(0, 200));
    }

    return warnings;
  }

  private parseStat(raw: unknown): 'physical' | 'wisdom' | 'intelligence' | 'charisma' {
    const s = String(raw ?? 'physical');
    if (['physical', 'wisdom', 'intelligence', 'charisma'].includes(s)) {
      return s as 'physical' | 'wisdom' | 'intelligence' | 'charisma';
    }
    return 'physical';
  }

  /** Per-option stat override: a valid stat string, or undefined when absent/invalid. */
  private parseOptionStat(raw: unknown): 'physical' | 'wisdom' | 'intelligence' | 'charisma' | undefined {
    if (raw === undefined || raw === null) return undefined;
    const s = String(raw);
    return ['physical', 'wisdom', 'intelligence', 'charisma'].includes(s)
      ? (s as 'physical' | 'wisdom' | 'intelligence' | 'charisma')
      : undefined;
  }
}

/** Strip carriage returns from LLM-authored prose so they don't render as `␍` in Discord. */
function stripCR(s: string): string {
  return s.replace(/\r/g, '');
}
