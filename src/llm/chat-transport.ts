// Shared raw HTTP mechanics for the chat completions upstream — extracted from ProdLlmGateway's
// 4 near-identical inline `fetch` blocks (decide/enrich/summarizeWeek/critique) so the wire format
// (request shape, auth header, timeout/abort, response envelope) lives in ONE place instead of
// four copies that could silently drift.
//
// Deliberately policy-free: whether a non-2xx or empty-content response should throw, fail open,
// or retry is different per caller (see ProdLlmGateway.ts) — this function only builds the
// request, sends it, and reports back a uniform envelope. It never throws on `!response.ok` or on
// empty `content`; every caller's existing error-handling behaviour is reproduced verbatim on top
// of this envelope, not folded in here.
//
// Three wire details are OpenRouter's rather than DeepSeek's, and every one of them fails
// *silently* if you get it wrong, so they are called out here:
//
//  - Chain-of-thought is requested with `reasoning: { enabled: true }`. DeepSeek's native
//    `thinking: { type: 'enabled' }` is not recognised on this hop: it is accepted, ignored, and
//    the response comes back without reasoning. No error, no warning.
//  - It comes back on `message.reasoning`. OpenRouter normalises every vendor's chain-of-thought
//    into that field, so DeepSeek's native `message.reasoning_content` is absent.
//  - Omitting the field is NOT "reasoning off". This model reasons unless told otherwise
//    (OpenRouter reports `default_enabled: true` for `deepseek/deepseek-v4.1-flash`, whose
//    efforts are max/high/low with no `off`), so silence buys a chain-of-thought on every stage —
//    billed as completion tokens and emitted before the content. Probed on the live API: a silent
//    body came back with 28 reasoning tokens, the same body with `{enabled: false}` with none.
//    So the field is sent on every call, and never conditionally.
import { OPENROUTER_TITLE, OPENROUTER_URL, OPENROUTER_PROVIDER_ROUTING } from './openrouter.js';

/** The wire body, minus the per-call plumbing. Split out so the one caller that needs to *log* the
 *  request (ProdLlmGateway's verbose line) builds it through this function rather than a copy that
 *  drifts from what is actually sent. */
export interface ChatRequestBodyInput {
  model: string;
  temperature: number;
  systemPrompt: string;
  userMessage: string;
  /** Ask for chain-of-thought. Only decide/critic (and the pipeline's decide stage) opt in; every
   *  other stage sends an explicit off — see the omission trap above. */
  reasoning?: boolean;
}

export interface ChatRequest extends ChatRequestBodyInput {
  apiKey: string;
  /** Abort timeout in ms. Default 60000; the weekly recap uses 30000 (a bigger payload, off the
   *  hot path). */
  timeoutMs?: number;
  /** Injectable fetch for testing. */
  fetchFn: typeof fetch;
}

export interface ChatResponse {
  ok: boolean;
  httpStatus: number;
  /** `choices[0].message.content ?? null`. An empty string is passed through as-is (not
   *  coerced to null) — callers that treat empty content as "nothing came back" already check
   *  falsiness, not strict null, so this preserves their exact behaviour. */
  content: string | null;
  reasoning: string | null;
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** `response.text()` — only populated when `!ok`, mirroring each caller's existing
   *  `!response.ok` branch (`response.text().catch(() => '')`). */
  errorText?: string;
}

export function buildRequestBody(req: ChatRequestBodyInput) {
  return {
    model: req.model,
    messages: [
      { role: 'system' as const, content: req.systemPrompt },
      { role: 'user' as const, content: req.userMessage },
    ],
    response_format: { type: 'json_object' as const },
    reasoning: { enabled: req.reasoning === true },
    temperature: req.temperature,
    stream: false,
    provider: OPENROUTER_PROVIDER_ROUTING,
  };
}

export async function callChatCompletion(req: ChatRequest): Promise<ChatResponse> {
  const requestBody = buildRequestBody(req);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 60000);

  try {
    const response = await req.fetchFn(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${req.apiKey}`,
        'X-Title': OPENROUTER_TITLE,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return {
        ok: false,
        httpStatus: response.status,
        content: null,
        reasoning: null,
        finishReason: null,
        errorText,
      };
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string; reasoning?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const message = data.choices?.[0]?.message;
    return {
      ok: true,
      httpStatus: response.status,
      content: message?.content ?? null,
      reasoning: message?.reasoning ?? null,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      usage: data.usage,
    };
  } finally {
    clearTimeout(timeout);
  }
}
