import type Database from 'better-sqlite3';
import type { LlmCallRecord, LlmCallRecorder } from '../../llm/LlmCallRecorder.js';
import type { LlmCallRow } from './types.js';

export type { LlmCallRow };

/**
 * Persists per-attempt LLM audit rows (POC instrumentation). Implements
 * LlmCallRecorder so it can be injected into the gateway.
 */
export class LlmCallRepository implements LlmCallRecorder {
  constructor(private db: Database.Database) {}

  record(rec: LlmCallRecord): number {
    const result = this.db
      .prepare(`
        INSERT INTO llm_calls (
          app_version, prompt_version, call_kind, critic_severity, model, temperature, tier, player_input, context_digest,
          raw_prompt, reasoning, response_json, parse_ok, validation_warnings,
          error, http_status, prompt_tokens, completion_tokens, total_tokens,
          reasoning_chars, latency_ms, finish_reason
        ) VALUES (
          @app_version, @prompt_version, @call_kind, @critic_severity, @model, @temperature, @tier, @player_input, @context_digest,
          @raw_prompt, @reasoning, @response_json, @parse_ok, @validation_warnings,
          @error, @http_status, @prompt_tokens, @completion_tokens, @total_tokens,
          @reasoning_chars, @latency_ms, @finish_reason
        )
      `)
      .run({
        app_version: rec.appVersion,
        prompt_version: rec.promptVersion,
        call_kind: rec.callKind ?? 'decision',
        critic_severity: rec.criticSeverity ?? null,
        model: rec.model,
        temperature: rec.temperature,
        tier: rec.tier,
        player_input: rec.playerInput,
        context_digest: rec.contextDigest,
        raw_prompt: rec.rawPrompt,
        reasoning: rec.reasoning,
        response_json: rec.responseJson,
        parse_ok: rec.parseOk ? 1 : 0,
        validation_warnings: JSON.stringify(rec.validationWarnings),
        error: rec.error,
        http_status: rec.httpStatus,
        prompt_tokens: rec.promptTokens,
        completion_tokens: rec.completionTokens,
        total_tokens: rec.totalTokens,
        reasoning_chars: rec.reasoningChars,
        latency_ms: rec.latencyMs,
        finish_reason: rec.finishReason,
      });
    return Number(result.lastInsertRowid);
  }

  /** Link a recorded call to the action row it produced (best-effort). */
  linkAction(callId: number, actionId: number): void {
    this.db
      .prepare('UPDATE llm_calls SET action_id = ? WHERE id = ?')
      .run(actionId, callId);
  }

  /** Backfill raw_prompt/reasoning on an existing call (critic flagged a beat that wasn't deep-
   *  captured at record time). COALESCE only fills NULLs — never erases an existing capture. */
  promoteDeepCapture(callId: number, fields: { rawPrompt?: string | null; reasoning?: string | null }): void {
    this.db
      .prepare(
        `UPDATE llm_calls
           SET raw_prompt = COALESCE(@raw_prompt, raw_prompt),
               reasoning  = COALESCE(@reasoning, reasoning)
         WHERE id = @id`,
      )
      .run({ id: callId, raw_prompt: fields.rawPrompt ?? null, reasoning: fields.reasoning ?? null });
  }
}
