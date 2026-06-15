// Source: https://api-docs.deepseek.com/ — OpenAI-compatible API
// Chat completions: POST /chat/completions with Bearer auth
// JSON mode: response_format: { type: "json_object" } — https://api-docs.deepseek.com/guides/json_mode

import type { LlmGateway, LlmContext, LlmDecision } from './LlmGateway.js';
import { buildSystemPrompt, buildUserMessage } from './prompt-builder.js';

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
      thinking: { type: 'disabled' as const },
      temperature: this.temperature,
      stream: false,
    };

    if (this.verbose) {
      console.log('[llm:request]', JSON.stringify(requestBody, null, 2));
    }

    const response = await this.fetchFn('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('[llm:error]', response.status, errText);
      throw new Error(`DeepSeek API error ${response.status}: ${errText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('DeepSeek returned empty response');
    }

    if (this.verbose) {
      console.log('[llm:response:raw]', content);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error('[llm:parse-error]', content.slice(0, 500));
      throw new Error(`Failed to parse DeepSeek response: ${content.slice(0, 200)}`);
    }

    if (this.verbose) {
      console.log('[llm:parsed]', JSON.stringify(parsed, null, 2));
    }

    return this.parseDecision(parsed);
  }

  private parseDecision(raw: Record<string, unknown>): LlmDecision {
    return {
      ...(raw.prompt !== undefined ? { prompt: String(raw.prompt) } : {}),
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
      ...(raw.mutations !== undefined ? { mutations: raw.mutations as unknown[] } : {}),
      ...(raw.outcome_text !== undefined ? { outcomeText: String(raw.outcome_text) } : {}),
    };
  }

  private parseStat(raw: unknown): 'physical' | 'wisdom' | 'intelligence' | 'charisma' {
    const s = String(raw ?? 'physical');
    if (['physical', 'wisdom', 'intelligence', 'charisma'].includes(s)) {
      return s as 'physical' | 'wisdom' | 'intelligence' | 'charisma';
    }
    return 'physical';
  }
}
