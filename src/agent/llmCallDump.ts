/**
 * The `<AGENT_OUT>.llm-calls.json` dump: every `llm_calls` row a live run recorded, read out of the
 * run's `:memory:` DB before the process exits. DB-in/data-out, so a test proves the dump is whole
 * without paying for a run.
 */

import type Database from 'better-sqlite3';

/** One whole audit row, in the column names a mining query reads. Columns that only serve the DB
 *  itself (`id`, `response_json`, `player_input`, `temperature`, `finish_reason`) are left out. */
export interface LlmCallDumpEntry {
  action_id: number | null;
  prompt_version: string;
  call_kind: string;
  critic_severity: string | null;
  beat: string | null;
  model: string;
  tier: number;
  context_digest: string | null;
  raw_prompt: string | null;
  reasoning: string | null;
  parse_ok: number;
  validation_warnings: string | null;
  error: string | null;
  http_status: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_chars: number | null;
  latency_ms: number | null;
  created_at: string;
}

/** Every row, in row order. `created_at` is SQLite's second-resolution stamp, so file order is the
 *  only reliable chronology in the dump. */
export function buildLlmCallDump(db: Database.Database): LlmCallDumpEntry[] {
  return db
    .prepare(
      `SELECT action_id, prompt_version, call_kind, critic_severity, beat, model, tier,
              context_digest, raw_prompt, reasoning, parse_ok, validation_warnings, error,
              http_status, prompt_tokens, completion_tokens, reasoning_chars, latency_ms, created_at
       FROM llm_calls
       ORDER BY id`,
    )
    .all() as LlmCallDumpEntry[];
}

/** Beside the transcript and the protocol log. Derived from `AGENT_OUT` alone, so the dump invents
 *  no path of its own and carries nothing about the host into the run's durable record. */
export function llmCallDumpPath(outPath: string): string {
  return `${outPath}.llm-calls.json`;
}
