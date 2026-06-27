// DeepSeek: OpenAI-compatible chat completions with Bearer auth + JSON mode.
// https://api-docs.deepseek.com/

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
  CriticGateway,
  CriticInput,
  CriticVerdict,
} from './LlmGateway.js';
import type { LlmCallRecorder } from './LlmCallRecorder.js';
import {
  buildSystemPrompt,
  buildUserMessage,
  buildContextDigest,
  buildCriticSystemPrompt,
  buildCriticUserMessage,
  PROMPT_VERSION,
  CRITIC_VERSION,
} from './prompt-builder.js';
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
  /** Persist reasoning on EVERY call, not just diagnostic ones (costs DB space). Env: LOG_LLM_THINKING_ALL. */
  logThinkingAll?: boolean;
  /**
   * Always persist reasoning + raw prompt when `reasoning_chars` exceeds this, regardless of
   * `logThinkingAll` — a long chain is itself a "spiral" signal worth mining. Defaults to
   * {@link REASONING_SPIRAL_CHARS_DEFAULT}. Env: REASONING_SPIRAL_CHARS.
   */
  reasoningSpiralChars?: number;
}

/** "Spiral" threshold (reasoning chars) past which thinking + prompt are always kept. ~p90 of observed lengths. */
export const REASONING_SPIRAL_CHARS_DEFAULT = 6000;

/** System prompt for the D3 cartographer — a tiny, focused world-builder. */
const CARTOGRAPHER_SYSTEM_PROMPT = `You are the cartographer for The Warden's Oak, a dark-fantasy text RPG. A player's action just took them to a place that is NOT yet on the map, so a provisional entry was created. Your job is to chart it.

You are given the NEW place's name, the list of ALREADY-KNOWN locations, and the narrative that led the player there.

Decide:
- Is this genuinely a NEW place, or is the new name just a synonym for one already in the known list (e.g. "The Temple" for "The Shrine of the First Flame")? If it is a duplicate, set "matchesExisting" to the EXACT existing name.
- Is it safe (a settlement, sanctuary, indoors-with-people) or wild (wilderness, ruins, open road, anywhere danger roams)? Off-map places are usually wild.
- Write a vivid one-paragraph description (2-3 sentences) in the game's grim tone that fits the narrative and the name.
- Choose 3-6 scene tags that capture the place's terrain and feel, used to pick its artwork. PREFER tags from this palette, picking the closest matches; add a plainer descriptive word only if nothing fits:
  oak, interior, fire, sanctuary, warden, forest, trees, wilderness, dark, canopy, edge, field, boundary, river, water, stream, crossing, bank, bridge, stone, arch, road, travel, open, path, horizon, ruins, ancient, broken, old, shrine, temple, holy, quiet, town, square, buildings, cobblestone, market, shop, village, goods, trade, tavern, crowd, drink, forge, smithy, building, library, study, scrolls, cave, entrance, rock, opening, underground, mountain, pass, rocky, high, narrow, coast, shore, lake, farm, crops, rural, swamp, bog, wet, mist, marsh, tower, watch, lookout, smoke, east, threat, ash, danger, campfire, rest, night, safe.

Return ONLY valid JSON, no markdown fences:
{
  "matchesExisting": "<exact existing name, or omit if genuinely new>",
  "is_safe": 0 or 1,
  "description": "<2-3 sentence description>",
  "tags": "<3-6 comma-separated lowercase tags>"
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

export class DeepseekLlmGateway implements LlmGateway, CartographerGateway, RecapGateway, CriticGateway {
  private apiKey: string;
  private model: string;
  private temperature: number;
  private fetchFn: typeof fetch;
  private verbose: boolean;
  private recorder?: LlmCallRecorder;
  private logThinkingAll: boolean;
  private reasoningSpiralChars: number;

  constructor(config: DeepseekConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'deepseek-v4-flash';
    this.temperature = config.temperature ?? 0.7;
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.verbose = config.verbose ?? false;
    this.recorder = config.recorder;
    this.logThinkingAll = config.logThinkingAll ?? false;
    this.reasoningSpiralChars = config.reasoningSpiralChars ?? REASONING_SPIRAL_CHARS_DEFAULT;
  }

  async decide(context: LlmContext): Promise<LlmDecision> {
    // Audit fields recorded in `finally`, so failures and retries are captured too.
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
          // Diagnostic = the call went wrong (transport error, unparseable response, or a retry).
          // Deep-capture (raw prompt + thinking) always fires for these; on well-formed calls it's
          // opt-in via the env toggle, plus always on a "spiral" (over-long reasoning chain).
          const isDiagnostic = (context.attemptTier ?? 0) > 0 || errorMsg !== null || !parseOk;
          const isSpiral = (reasoningChars ?? 0) > this.reasoningSpiralChars;
          const captureDeep = isDiagnostic || isSpiral || this.logThinkingAll;
          const callId = this.recorder.record({
            appVersion: APP_VERSION,
            promptVersion: PROMPT_VERSION,
            callKind: 'decision',
            model: this.model,
            temperature: this.temperature,
            tier: context.attemptTier ?? 0,
            playerInput: context.rawInput,
            contextDigest: buildContextDigest(context),
            rawPrompt: captureDeep ? rawPrompt : null,
            reasoning: captureDeep ? reasoning : null,
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
    // Report up front so the prompt is captured even if the request throws.
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
    const warnings = this.validateDecision(parsed, decision);
    onProgress({ warnings });
    // Surface warnings so the coherence critic can gate on them (Thread 2).
    decision._warnings = warnings;
    // Hold prompt + reasoning transiently so the critic can backfill this call's audit row if it
    // flags the beat (even when deep-capture wasn't triggered at record time).
    decision._rawPrompt = userMessage;
    decision._reasoning = reasoningContent;

    // D1: reject a completely empty turn (no options, mutations, or outcome text) — there's nothing
    // to resolve, so surfacing it would burn a roll. Throw so the fallback gateway retries (and,
    // failing that, hands the player divine intervention).
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
   * D3 cartographer call. Best-effort: never throws on parse/transport failure — returns an empty
   * result so the caller leaves the provisional row as-is. Not audited (off-critical-path).
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
      const tags = normalizeTags(parsed.tags);
      if (tags) result.tags = tags;
      return result;
    } catch (err) {
      console.warn(c.yellow('[cartographer] enrich failed'), err instanceof Error ? err.message : String(err));
      return {};
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Weekly recap call. Throws on transport/parse failure so the caller's deterministic fallback
   * header takes over (the recap must never block the Monday beat). Not audited (a reporting concern).
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

  /**
   * Coherence-critic call (Thread 2). Reviews one authored beat against engine truths, returns a
   * verdict, and records to llm_calls tagged `call_kind='critic'` / `prompt_version='critic-<N>'`.
   * Best-effort: never throws — on any error it fails open to `ok`, so a critic outage can't block
   * gameplay (the deterministic-safe original passes through).
   */
  async critique(input: CriticInput): Promise<CriticVerdict> {
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    let finishReason: string | null = null;
    let reasoningChars: number | null = null;
    let reasoning: string | null = null;
    let responseJson: string | null = null;
    let parseOk = false;
    let errorMsg: string | null = null;

    // Fail-open default: if anything goes wrong, the beat is deemed coherent (pass through).
    let verdict: CriticVerdict = { ok: true, severity: 'minor', issues: [] };

    const userMessage = buildCriticUserMessage(input);

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
            { role: 'system' as const, content: buildCriticSystemPrompt() },
            { role: 'user' as const, content: userMessage },
          ],
          response_format: { type: 'json_object' as const },
          thinking: { type: 'enabled' as const },
          temperature: this.temperature,
          stream: false,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      httpStatus = response.status;
      if (!response.ok) {
        throw new Error(`critic API error ${response.status}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const reasoningContent = data.choices?.[0]?.message?.reasoning_content ?? null;
      reasoning = reasoningContent;
      reasoningChars = reasoningContent?.length ?? null;
      usage = data.usage;
      finishReason = data.choices?.[0]?.finish_reason ?? null;

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('critic returned empty content');
      }
      responseJson = content;
      const parsed = JSON.parse(content) as Record<string, unknown>;
      parseOk = true;
      verdict = this.parseCriticVerdict(parsed);
      // On a flag, backfill the CRITIQUED decision's own audit row with its prompt + reasoning (held
      // transiently on the decision) so the rejected output is mineable on its own row. Best-effort.
      if (!verdict.ok && this.recorder && input.decision._llmCallId !== undefined) {
        try {
          this.recorder.promoteDeepCapture(input.decision._llmCallId, {
            rawPrompt: input.decision._rawPrompt ?? null,
            reasoning: input.decision._reasoning ?? null,
          });
        } catch (promoteErr) {
          console.error(c.red('[critic:audit] promoteDeepCapture failed'), promoteErr);
        }
      }
      return verdict;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(c.yellow('[critic] failed — failing open to ok'), errorMsg);
      return verdict;
    } finally {
      if (this.recorder) {
        try {
          // Diagnostic = the critic call went wrong (transport/parse). Deep-capture always fires for
          // these; on a well-formed call it's opt-in via the env toggle, plus always on a spiral or a
          // flag (a flag's prompt embeds the critiqued decision, mining output + reason together).
          const isDiagnostic = errorMsg !== null || !parseOk;
          const isSpiral = (reasoningChars ?? 0) > this.reasoningSpiralChars;
          const flagged = parseOk && !verdict.ok;
          const captureDeep = isDiagnostic || isSpiral || this.logThinkingAll || flagged;
          const callId = this.recorder.record({
            appVersion: APP_VERSION,
            promptVersion: `critic-${CRITIC_VERSION}`,
            callKind: 'critic',
            criticSeverity: parseOk ? (verdict.ok ? 'ok' : verdict.severity) : null,
            model: this.model,
            temperature: this.temperature,
            tier: 0,
            playerInput: input.playerInput,
            contextDigest: input.contextDigest,
            rawPrompt: captureDeep ? userMessage : null,
            reasoning: captureDeep ? reasoning : null,
            responseJson,
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
          });
          // Surface the audit row id so the caller can link the critic call to the action.
          verdict._llmCallId = callId;
        } catch (recErr) {
          console.error(c.red('[critic:audit] failed to record call'), recErr);
        }
      }
    }
  }

  /** Parse + clamp a critic verdict. Defaults to coherent; honours a prose patch only on a minor
   *  defect (texture-only — `prompt` / `outcome_text`). */
  private parseCriticVerdict(raw: Record<string, unknown>): CriticVerdict {
    const ok = raw.ok !== false; // coherent unless explicitly false
    const severity: 'minor' | 'major' = raw.severity === 'major' ? 'major' : 'minor';
    const issues = Array.isArray(raw.issues)
      ? raw.issues.filter((i): i is string => typeof i === 'string')
      : [];
    const verdict: CriticVerdict = { ok, severity, issues };

    if (!ok && severity === 'minor' && raw.patch && typeof raw.patch === 'object') {
      const rawPatch = raw.patch as Record<string, unknown>;
      const patch: { prompt?: string; outcomeText?: string } = {};
      if (typeof rawPatch.prompt === 'string') patch.prompt = stripCR(rawPatch.prompt);
      if (typeof rawPatch.outcome_text === 'string') patch.outcomeText = stripCR(rawPatch.outcome_text);
      if (patch.prompt !== undefined || patch.outcomeText !== undefined) verdict.patch = patch;
    }

    return verdict;
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
              // Attach only on a valid stat — keeps the common no-override shape exactly { label, dcModifier }.
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
      // Empty `decision` is the prompt's "resolve outright" signal (v7+ dropped `done`); only a
      // problem when there's nothing to resolve WITH — no mutations and no outcome_text.
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

    // Rule 4b: a resolving turn (v8 signal = empty `decision`; legacy `done` honoured as a backstop,
    // E3) whose mutations are only negative stamina/health reads as a failure on a SUCCESS. Quality warning.
    const isResolving = d.done || d.decision.length === 0;
    if (isResolving && Array.isArray(raw.mutations) && raw.mutations.length > 0) {
      const hasReward = (raw.mutations as Array<Record<string, unknown>>).some(m => {
        if (!m || typeof m !== 'object') return false;
        const type = String(m.type ?? '');
        if (['add_item', 'spawn_npc', 'set_location', 'cross_frontier'].includes(type)) return true;
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

/**
 * Normalize cartographer tags (a string "a, b" or an array ["a","b"]) into the canonical
 * comma-separated lowercase form the DB and TagResolver expect. Returns undefined if empty.
 */
function normalizeTags(raw: unknown): string | undefined {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    const t = p.trim().toLowerCase();
    if (t !== '') seen.add(t);
  }
  return seen.size > 0 ? [...seen].join(',') : undefined;
}
