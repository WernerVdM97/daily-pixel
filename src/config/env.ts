// Central parse of the logging/debug env contract (hotfix: standardise logging env vars).
// Kept separate from any single gateway so both DeepseekLlmGateway and ProdPipelineLlmGateway
// read the same names/semantics — the prod gap this closes was the pipeline silently ignoring
// a var the legacy gateway honoured.

import { SPIRAL_CHARS_DEFAULT } from '../llm/capture-policy.js';

export type ThinkingLogMode = 'errors' | 'spiral' | 'all';

export interface LoggingEnv {
  verbose: boolean;
  verboseLlm: boolean;
  llmLogThinking: ThinkingLogMode;
  llmSpiralChars: number;
}

const THINKING_MODES: readonly ThinkingLogMode[] = ['errors', 'spiral', 'all'];

/** True iff the var is set to "true" or "1" (trimmed, case-insensitive). */
export function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** Positive integer or undefined for unset/empty/NaN/<=0. */
export function envInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function parseThinkingMode(value: string | undefined): ThinkingLogMode {
  const v = value?.trim().toLowerCase();
  // Invalid/unset values fall back to 'spiral' — the safe middle ground between the
  // always-on 'errors' floor and the DB-hungry 'all'.
  return (THINKING_MODES as readonly string[]).includes(v ?? '') ? (v as ThinkingLogMode) : 'spiral';
}

export function readLoggingEnv(env: NodeJS.ProcessEnv = process.env): LoggingEnv {
  return {
    verbose: envFlag(env.VERBOSE),
    verboseLlm: envFlag(env.VERBOSE_LLM),
    llmLogThinking: parseThinkingMode(env.LLM_LOG_THINKING),
    llmSpiralChars: envInt(env.LLM_SPIRAL_CHARS) ?? SPIRAL_CHARS_DEFAULT,
  };
}

/** Removed var name → migration hint shown in the boot warning. */
const STALE_VAR_HINTS: Record<string, string> = {
  LOG_LLM_THINKING_ALL: 'LLM_LOG_THINKING=all',
  LLM_LOG_ALL_PROMPTS: 'LLM_LOG_THINKING=all',
  REASONING_SPIRAL_CHARS: 'LLM_SPIRAL_CHARS',
};

/** Names of removed vars still present in env, paired with migration hints — for boot warnings. */
export function staleLoggingEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(STALE_VAR_HINTS)
    .filter(([name]) => env[name] !== undefined)
    .map(([name, hint]) => `${name} is removed — use ${hint}`);
}
