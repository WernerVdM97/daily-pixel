// Shared raw HTTP mechanics for DeepSeek chat completions — extracted from
// DeepseekLlmGateway's 4 near-identical inline `fetch` blocks (decide/enrich/summarizeWeek/
// critique) so the wire format (request shape, auth header, timeout/abort, response envelope)
// lives in ONE place instead of four copies that could silently drift.
//
// Deliberately policy-free: whether a non-2xx or empty-content response should throw, fail
// open, or retry is different per caller (see DeepseekLlmGateway.ts) — this function only
// builds the request, sends it, and reports back a uniform envelope. It never throws on
// `!response.ok` or on empty `content`; every caller's existing error-handling behaviour is
// reproduced verbatim on top of this envelope, not folded in here.
export interface DeepseekRequest {
  apiKey: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  userMessage: string;
  /** Enables DeepSeek's `thinking` mode (chain-of-thought surfaced as `reasoning_content`).
   *  Default false — only decide/critic (and now the pipeline's decide stage) opt in. */
  thinking?: boolean;
  /** Abort timeout in ms. Default 15000; the weekly recap uses 30000 (a bigger payload, off the
   *  hot path). */
  timeoutMs?: number;
  /** Injectable fetch for testing. */
  fetchFn: typeof fetch;
}

export interface DeepseekResponse {
  ok: boolean;
  httpStatus: number;
  /** `choices[0].message.content ?? null`. An empty string is passed through as-is (not
   *  coerced to null) — callers that treat empty content as "nothing came back" already check
   *  falsiness, not strict null, so this preserves their exact behaviour. */
  content: string | null;
  reasoningContent: string | null;
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** `response.text()` — only populated when `!ok`, mirroring each caller's existing
   *  `!response.ok` branch (`response.text().catch(() => '')`). */
  errorText?: string;
}

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export async function callDeepseek(req: DeepseekRequest): Promise<DeepseekResponse> {
  const requestBody = {
    model: req.model,
    messages: [
      { role: 'system' as const, content: req.systemPrompt },
      { role: 'user' as const, content: req.userMessage },
    ],
    response_format: { type: 'json_object' as const },
    ...(req.thinking ? { thinking: { type: 'enabled' as const } } : {}),
    temperature: req.temperature,
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 60000);

  try {
    const response = await req.fetchFn(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${req.apiKey}`,
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
        reasoningContent: null,
        finishReason: null,
        errorText,
      };
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const message = data.choices?.[0]?.message;
    return {
      ok: true,
      httpStatus: response.status,
      content: message?.content ?? null,
      reasoningContent: message?.reasoning_content ?? null,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      usage: data.usage,
    };
  } finally {
    clearTimeout(timeout);
  }
}
