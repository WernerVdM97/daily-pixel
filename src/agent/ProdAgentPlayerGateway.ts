/**
 * Production, OpenRouter-backed `AgentPlayerGateway` (JSON-seam M4.1). The agent-player's brain: it
 * renders the current turn into a user message, asks the model to pick a move, and maps the reply
 * back to one of the legal `AgentMove`s, wrapped in the `BrainTurn` the harness reads. Only the
 * MOVE half of the reply is resolved here: the note fields (`intent`, `arcNote`, `friction`,
 * `dayNote`) are not parsed yet, so a reply carrying them returns the move alone.
 *
 * Mirrors `ProdPipelineLlmGateway` deliberately: reuses `callChatCompletion` verbatim (JSON mode,
 * single attempt, no retry/fallback at this layer), throws loudly on transport/parse/validation
 * failure so the harness sees the failure, and records ONE `llm_calls` audit row in `finally`
 * regardless of outcome. A recorder error is logged, never rethrown.
 *
 * This is the ONLY agent module that reaches into `src/llm/` — the seam types stay clean; only the
 * concrete brain depends on the transport.
 */

import { callChatCompletion, type ChatResponse } from '../llm/chat-transport.js';
import { DEFAULT_LLM_MODEL } from '../llm/openrouter.js';
import type { LlmCallRecorder } from '../llm/LlmCallRecorder.js';
import { APP_VERSION } from '../version.js';
import { c } from '../util/colors.js';
import type { AgentMove, AgentPlayerGateway, BrainTurn, ChooseMoveInput } from './AgentPlayerGateway.js';
import { agentPlayerStamp, loadBrainPrompt, loadHandbookPrompt } from './agentPrompt.js';

export interface ProdAgentPlayerGatewayConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Optional audit sink — records every move-pick attempt as an `llm_calls` row. */
  recorder?: LlmCallRecorder;
  /** Injectable system prompt for tests. Defaults to the versioned file on disk. */
  systemPrompt?: string;
  /** If true, console-log a one-line summary per call (model, latency, tokens, snippet). */
  verbose?: boolean;
}

/** The shape the brain must return (see `brain.md`). `choice` indexes into the turn's MOVES
 *  list; `text` is present only for a free-text move. */
interface RawMovePick {
  thought?: unknown;
  choice?: unknown;
  text?: unknown;
}

const CALL_KIND = 'agent-player';

export class ProdAgentPlayerGateway implements AgentPlayerGateway {
  private apiKey: string;
  private model: string;
  private temperature: number;
  private fetchFn: typeof fetch;
  private recorder?: LlmCallRecorder;
  private systemPrompt: string;
  private verbose: boolean;

  constructor(config: ProdAgentPlayerGatewayConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_LLM_MODEL;
    this.temperature = config.temperature ?? 0.7;
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.recorder = config.recorder;
    // The v2 set fires as a unit: the move-picker's instruction plus the first-time-player
    // handbook every brain carries (T3 appends the persona fragment after these two).
    this.systemPrompt = config.systemPrompt ?? `${loadBrainPrompt()}\n\n${loadHandbookPrompt()}`;
    this.verbose = config.verbose ?? false;
  }

  async chooseMove(input: ChooseMoveInput): Promise<BrainTurn> {
    const userMessage = buildUserMessage(input);
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let usage: ChatResponse['usage'];
    let finishReason: string | null = null;
    let reasoningContent: string | null = null;
    let content: string | null = null;
    let parseOk = false;
    let errorMsg: string | null = null;
    let move: AgentMove | undefined;

    try {
      const res = await callChatCompletion({
        apiKey: this.apiKey,
        model: this.model,
        temperature: this.temperature,
        systemPrompt: this.systemPrompt,
        userMessage,
        reasoning: true,
        fetchFn: this.fetchFn,
      });

      httpStatus = res.httpStatus;
      usage = res.usage;
      finishReason = res.finishReason;
      reasoningContent = res.reasoning;

      if (!res.ok) {
        throw new Error(
          `ProdAgentPlayerGateway: OpenRouter API error ${res.httpStatus}${res.errorText ? `: ${res.errorText}` : ''}`,
        );
      }
      if (res.content === null) {
        throw new Error('ProdAgentPlayerGateway: OpenRouter returned empty response');
      }
      content = res.content;

      let raw: RawMovePick;
      try {
        raw = JSON.parse(content) as RawMovePick;
      } catch {
        throw new Error(`ProdAgentPlayerGateway: failed to parse OpenRouter response: ${content.slice(0, 200)}`);
      }
      parseOk = true;

      move = resolveMove(raw, input);

      if (this.verbose) {
        const latencyMs = Date.now() - startedAt;
        console.log(
          c.cyan('[agent:move]'),
          `model=${this.model} latency=${latencyMs}ms tokens=${usage?.total_tokens ?? '?'}`,
          JSON.stringify(move),
        );
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      if (content !== null) {
        console.error(c.red('[agent:move]'), errorMsg, content.slice(0, 500));
      } else {
        console.error(c.red('[agent:move]'), errorMsg);
      }
      throw err;
    } finally {
      if (this.recorder) {
        try {
          this.recorder.record({
            appVersion: APP_VERSION,
            promptVersion: agentPlayerStamp(),
            callKind: CALL_KIND,
            model: this.model,
            temperature: this.temperature,
            tier: 0,
            playerInput: input.screenText,
            contextDigest: buildContextDigest(input),
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
          console.error('[agent:audit] failed to record call', recErr);
        }
      }
    }

    if (move === undefined) {
      // Unreachable: the try block leaves only via a return-assigned `move` or a throw that
      // propagates past this point. Guard is compile-time defence against a future early return.
      throw new Error('unreachable: move was never set');
    }
    return { move };
  }
}

/** Map the brain's `{ choice, text }` reply to a concrete legal `AgentMove`. Throws loudly on an
 *  out-of-range choice or a free-text move with no text — the same "fail visibly" contract as the
 *  pipeline gateway's parse step. */
function resolveMove(raw: RawMovePick, input: ChooseMoveInput): AgentMove {
  const choice = Number(raw.choice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= input.moves.length) {
    throw new Error(
      `ProdAgentPlayerGateway: choice ${JSON.stringify(raw.choice)} is not a legal move index ` +
        `(0..${input.moves.length - 1})`,
    );
  }
  const picked = input.moves[choice].move;
  if (picked.kind === 'custom') {
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (text === '') {
      throw new Error('ProdAgentPlayerGateway: chose a free-text action but returned no text');
    }
    return { kind: 'custom', text };
  }
  return picked;
}

/** The turn rendered as the user message: the working memory a player carries (only the blocks
 *  that exist this turn — spec § B), then the screen, numbered legal moves and character state.
 *  Kept a free function (not a method) so tests can assert the exact wire text. */
export function buildUserMessage(input: ChooseMoveInput): string {
  const sections: string[] = [];
  // Each memory block is appended only when its field is present, so a first turn (and every turn
  // of a pre-rework call site) renders exactly the three keys the seam carried before.
  if (input.recap !== undefined) sections.push('RECAP:', input.recap, '');
  if (input.dayLog !== undefined) sections.push('TODAY SO FAR:', input.dayLog, '');
  if (input.intentNote !== undefined) sections.push('INTENT:', input.intentNote, '');
  if (input.arcNote !== undefined) sections.push('ARC:', input.arcNote, '');
  if (input.lastRecon !== undefined) sections.push(`LAST LOOK: /${input.lastRecon.screen}`, input.lastRecon.text, '');

  const moveLines = input.moves.map((m, i) => `${i}. ${m.label}`).join('\n');
  return [
    ...sections,
    'SCREEN:',
    input.screenText,
    '',
    'MOVES:',
    moveLines,
    '',
    'CHARACTER:',
    buildContextDigest(input),
  ].join('\n');
}

/** Compact one-line character digest for the user message + the `llm_calls` context digest. */
function buildContextDigest(input: ChooseMoveInput): string {
  const ch = input.character;
  return JSON.stringify({
    name: ch.name,
    class: ch.class,
    hp: `${ch.health}/${ch.maxHealth}`,
    stamina: `${ch.stamina}/${ch.maxStamina}`,
    rollsRemaining: ch.rollsRemaining,
    wealth: ch.wealth,
    location: ch.location,
  });
}
