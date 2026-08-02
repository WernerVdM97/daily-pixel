/**
 * Production, DeepSeek-backed `PlaytestCriticGateway` (JSON-seam M4.5). Renders a completed run into
 * a user message, asks DeepSeek for a qualitative playtest report, and validates the reply.
 *
 * Mirrors `ProdAgentPlayerGateway` deliberately: reuses `callDeepseek` verbatim (JSON mode, single
 * attempt, no retry/fallback at this layer), throws loudly on transport/parse/validation failure so
 * the caller sees it, and records ONE `llm_calls` audit row in `finally` regardless of outcome. A
 * recorder error is logged, never rethrown.
 */

import { callDeepseek, type DeepseekResponse } from '../llm/deepseek-transport.js';
import type { LlmCallRecorder } from '../llm/LlmCallRecorder.js';
import { APP_VERSION } from '../version.js';
import { c } from '../util/colors.js';
import type { CritiqueInput, PlaytestCriticGateway, PlaytestReport } from './PlaytestCriticGateway.js';
import type { TranscriptEvent } from './transcript.js';
import { AGENT_CRITIC_STAMP, loadCriticPrompt } from './criticPrompt.js';

export interface ProdPlaytestCriticGatewayConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Optional audit sink — records the critique attempt as an `llm_calls` row. */
  recorder?: LlmCallRecorder;
  /** Injectable system prompt for tests. Defaults to the versioned file on disk. */
  systemPrompt?: string;
  /** If true, console-log a one-line summary of the call (model, latency, tokens). */
  verbose?: boolean;
}

/** The shape the critic must return (see critic-v1.md) — the four dimensions plus an overall read. */
interface RawReport {
  pacing?: unknown;
  clarity?: unknown;
  fun?: unknown;
  difficulty?: unknown;
  summary?: unknown;
}

const CALL_KIND = 'agent-critic';

export class ProdPlaytestCriticGateway implements PlaytestCriticGateway {
  private apiKey: string;
  private model: string;
  private temperature: number;
  private fetchFn: typeof fetch;
  private recorder?: LlmCallRecorder;
  private systemPrompt: string;
  private verbose: boolean;

  constructor(config: ProdPlaytestCriticGatewayConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'deepseek-v4-flash';
    // Lower than the brain's 0.7 — this is analysis, not roleplay; steadier, more consistent reads.
    this.temperature = config.temperature ?? 0.4;
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.recorder = config.recorder;
    this.systemPrompt = config.systemPrompt ?? loadCriticPrompt();
    this.verbose = config.verbose ?? false;
  }

  async critique(input: CritiqueInput): Promise<PlaytestReport> {
    const userMessage = buildCritiqueMessage(input);
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let usage: DeepseekResponse['usage'];
    let finishReason: string | null = null;
    let reasoningContent: string | null = null;
    let content: string | null = null;
    let parseOk = false;
    let errorMsg: string | null = null;
    let report: PlaytestReport | undefined;

    try {
      const res = await callDeepseek({
        apiKey: this.apiKey,
        model: this.model,
        temperature: this.temperature,
        systemPrompt: this.systemPrompt,
        userMessage,
        thinking: true,
        fetchFn: this.fetchFn,
      });

      httpStatus = res.httpStatus;
      usage = res.usage;
      finishReason = res.finishReason;
      reasoningContent = res.reasoningContent;

      if (!res.ok) {
        throw new Error(
          `ProdPlaytestCriticGateway: DeepSeek API error ${res.httpStatus}${res.errorText ? `: ${res.errorText}` : ''}`,
        );
      }
      if (res.content === null) {
        throw new Error('ProdPlaytestCriticGateway: DeepSeek returned empty response');
      }
      content = res.content;

      let raw: RawReport;
      try {
        raw = JSON.parse(content) as RawReport;
      } catch {
        throw new Error(`ProdPlaytestCriticGateway: failed to parse DeepSeek response: ${content.slice(0, 200)}`);
      }
      parseOk = true;

      report = resolveReport(raw);

      if (this.verbose) {
        const latencyMs = Date.now() - startedAt;
        console.log(
          c.cyan('[agent:critique]'),
          `model=${this.model} latency=${latencyMs}ms tokens=${usage?.total_tokens ?? '?'}`,
        );
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      if (content !== null) {
        console.error(c.red('[agent:critique]'), errorMsg, content.slice(0, 500));
      } else {
        console.error(c.red('[agent:critique]'), errorMsg);
      }
      throw err;
    } finally {
      if (this.recorder) {
        try {
          this.recorder.record({
            appVersion: APP_VERSION,
            promptVersion: AGENT_CRITIC_STAMP,
            callKind: CALL_KIND,
            model: this.model,
            temperature: this.temperature,
            tier: 0,
            playerInput: `run: ${input.events.length} events, ${input.summary.outcomes} outcomes`,
            contextDigest: JSON.stringify(input.summary),
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
            rawPrompt: errorMsg !== null || !parseOk ? userMessage : null,
            reasoning: errorMsg !== null || !parseOk ? reasoningContent : null,
            criticSeverity: null,
          });
        } catch (recErr) {
          console.error('[agent:audit] failed to record critique call', recErr);
        }
      }
    }

    if (report === undefined) {
      // Unreachable: the try block leaves only via a return-assigned `report` or a throw that
      // propagates past here. Compile-time defence against a future early return.
      throw new Error('unreachable: report was never set');
    }
    return report;
  }
}

/** Validate the critic's `{ pacing, clarity, fun, difficulty, summary }` reply. Throws loudly if any
 *  dimension is missing or blank — the same "fail visibly" contract as the brain's move parse. */
function resolveReport(raw: RawReport): PlaytestReport {
  const fields = ['pacing', 'clarity', 'fun', 'difficulty', 'summary'] as const;
  const out = {} as PlaytestReport;
  for (const f of fields) {
    const v = raw[f];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`ProdPlaytestCriticGateway: report field "${f}" is missing or empty`);
    }
    out[f] = v.trim();
  }
  return out;
}

/** The completed run rendered as the user message: the scoreboard, then the play log in order. Kept
 *  a free function (not a method) so tests can assert the exact wire text. */
export function buildCritiqueMessage(input: CritiqueInput): string {
  return [
    'RUN SUMMARY:',
    JSON.stringify(input.summary),
    '',
    'PLAY LOG:',
    input.events.map(renderEvent).join('\n'),
  ].join('\n');
}

/** One transcript event as a single readable log line the critic reads. */
function renderEvent(e: TranscriptEvent): string {
  switch (e.type) {
    case 'turn':
      return `[${e.screen}] ${oneLine(e.text)}\n    → chose ${JSON.stringify(e.chosen)} (offered: ${e.offered.join(', ')})`;
    case 'outcome':
      return `OUTCOME: ${oneLine(e.text)}`;
    case 'commute':
      return `COMMUTE → ${e.destination}`;
    case 'dead-end':
      return `DEAD-END: ${e.reason}${e.detail ? ` (${oneLine(e.detail)})` : ''}`;
    case 'day':
      return `── NIGHT → day ${e.dayNumber}: ${e.note} ──`;
    case 'finding':
      return `⚠ FINDING [${e.severity}]: ${e.summary}${e.detail ? ` (${oneLine(e.detail)})` : ''}`;
  }
}

/** Collapse a multi-line screen render to a single log line — the critic reads the shape of play,
 *  not the ANSI framing, and a flat line keeps the log scannable. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
