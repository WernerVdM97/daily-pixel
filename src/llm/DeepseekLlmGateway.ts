// Source: https://api-docs.deepseek.com/ — OpenAI-compatible API
// Chat completions: POST /chat/completions with Bearer auth
// JSON mode: response_format: { type: "json_object" } — https://api-docs.deepseek.com/guides/json_mode

import type { LlmGateway, LlmContext, LlmDecision } from './LlmGateway.js';
import { buildSystemPrompt, buildUserMessage } from './prompt-builder.js';
import { c } from '../util/colors.js';

export interface DeepseekConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** If true, log all LLM request/response data to console. */
  verbose?: boolean;
}

export class DeepseekLlmGateway implements LlmGateway {
  private apiKey: string;
  private model: string;
  private temperature: number;
  private fetchFn: typeof fetch;
  private verbose: boolean;

  constructor(config: DeepseekConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'deepseek-v4-flash';
    this.temperature = config.temperature ?? 0.7;
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.verbose = config.verbose ?? false;
  }

  async decide(context: LlmContext): Promise<LlmDecision> {
    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(context);

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

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(c.red('[llm:error]'), response.status, errText);
      throw new Error(`DeepSeek API error ${response.status}: ${errText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string; reasoning_content?: string } }>;
    };

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

    if (this.verbose) {
      console.log(c.green('[llm:parsed]'), JSON.stringify(parsed, null, 2));
    }

    return this.parseDecision(parsed);
  }

  private parseDecision(raw: Record<string, unknown>): LlmDecision {
    const decision: LlmDecision = {
      ...(raw.prompt === undefined ? {} : { prompt: String(raw.prompt) }),
      distilledType: String(raw.distilled_type ?? ''),
      stat: this.parseStat(raw.stat),
      baseDc: Number(raw.base_dc ?? 10),
      required: Boolean(raw.required),
      done: Boolean(raw.done),
      decision: Array.isArray(raw.decision)
        ? raw.decision.map((opt: Record<string, unknown>) => ({
            label: String(opt.label ?? ''),
            dcModifier: opt.dc_modifier === null ? null : Number(opt.dc_modifier ?? 0),
          }))
        : [],
      ...(raw.mutations === undefined ? {} : { mutations: raw.mutations as unknown[] }),
      ...(raw.outcome_text === undefined ? {} : { outcomeText: String(raw.outcome_text) }),
    };

    this.validateDecision(raw, decision);
    return decision;
  }

  private validateDecision(raw: Record<string, unknown>, d: LlmDecision): void {
    const warnings: string[] = [];

    if (!d.distilledType) warnings.push('distilled_type is empty');

    const validStats = ['physical', 'wisdom', 'intelligence', 'charisma'];
    if (!validStats.includes(d.stat)) {
      warnings.push(`stat "${d.stat}" is not one of ${validStats.join('/')} (raw: ${JSON.stringify(raw.stat)})`);
    }

    if (d.baseDc < 8 || d.baseDc > 18) {
      warnings.push(`base_dc ${d.baseDc} is outside expected range 8-18`);
    }

    if (!Array.isArray(raw.decision)) {
      warnings.push('decision is not an array');
    } else if (!d.done && d.decision.length === 0) {
      warnings.push('decision array is empty but done=false — player will have no options');
    } else {
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
      }
    }

    if (warnings.length > 0) {
      console.warn(c.yellow('[llm:validate]'), warnings.join('; '));
      console.warn(c.yellow('[llm:validate] raw response:'), JSON.stringify(raw).slice(0, 500));
    }

    // Check mutations is an array when present
    if (raw.mutations !== undefined && !Array.isArray(raw.mutations)) {
      console.warn(c.yellow('[llm:validate] mutations is not an array:'), typeof raw.mutations, JSON.stringify(raw.mutations).slice(0, 200));
    }
  }

  private parseStat(raw: unknown): 'physical' | 'wisdom' | 'intelligence' | 'charisma' {
    const s = String(raw ?? 'physical');
    if (['physical', 'wisdom', 'intelligence', 'charisma'].includes(s)) {
      return s as 'physical' | 'wisdom' | 'intelligence' | 'charisma';
    }
    return 'physical';
  }
}
