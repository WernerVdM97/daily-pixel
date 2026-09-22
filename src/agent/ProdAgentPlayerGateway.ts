/**
 * Production, OpenRouter-backed `AgentPlayerGateway` (JSON-seam M4.1). The agent-player's brain: it
 * renders the current turn into a user message, asks the model to pick a move, and maps the reply
 * back to one of the legal `AgentMove`s, wrapped in the `BrainTurn` the harness reads. Both halves
 * of the reply are resolved here: the MOVE (`resolveMove`, fail-loud) and the NOTES (`resolveNotes`,
 * fail-soft — spec § E).
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
import type {
  AgentMove,
  AgentPlayerGateway,
  BrainTurn,
  ChooseMoveInput,
  DayNote,
  FrictionReport,
  Recurrence,
} from './AgentPlayerGateway.js';
import { agentPlayerStamp, loadBrainPrompt, loadHandbookPrompt, loadPersonaFragment } from './agentPrompt.js';

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
  /** The persona this brain plays as (spec § A/§ Versioning and wiring). Joins the system prompt
   *  after `brain.md` and `handbook.md`, and is stamped into every `llm_calls` row. Unset = the
   *  pre-persona brain (`agent-v2`), which is the baseline arm. */
  persona?: string;
  /** If true, console-log a one-line summary per call (model, latency, tokens, snippet). */
  verbose?: boolean;
}

/** The shape the brain must return (see `brain.md`). `choice` indexes into the turn's MOVES
 *  list; `text` is present only for a free-text move. The four note fields are optional and typed
 *  `unknown` on purpose: they arrive from a model, so they are validated rather than trusted. */
interface RawBrainReply {
  thought?: unknown;
  choice?: unknown;
  text?: unknown;
  intent?: unknown;
  arcNote?: unknown;
  friction?: unknown;
  dayNote?: unknown;
}

/** The note half of a reply, resolved: a field is present only when it survived validation. */
interface ResolvedNotes {
  intent?: string;
  arcNote?: string;
  friction?: FrictionReport;
  dayNote?: DayNote;
  /** One reason per dropped field, in reply-field order. Also the audit row's `validationWarnings`,
   *  so a lost data point leaves a trace even when the run carries on. Truncation is NOT a drop and
   *  is not reported here: see `checkLine`. */
  droppedNotes: string[];
}

const CALL_KIND = 'agent-player';

/** Cap on every free-text value that is re-sent to the model every turn (`intent`, `arcNote`,
 *  `friction.what`, the day note's persisted `arcNote`, a custom action's text). All of them are
 *  re-rendered into a later prompt, so an unbounded reply could grow the prompt every turn. 200 is
 *  comfortably more than the one short line the prompt asks for. */
const TEXT_MAX_LEN = 200;

/** A wider cap for the day note's `line` alone. It is rendered ONCE, into the day-note event and
 *  then the panel's series, and never re-sent as context — unlike the fields `TEXT_MAX_LEN` guards.
 *  The prompt asks for "one line on the day" and models write a sentence (a live run's line ran to
 *  151 characters against the old 200 ceiling), so the backstop against runaway growth sits at 400.
 *  The day note's `arcNote` stays at `TEXT_MAX_LEN`: it becomes the persisted `arcNote`, which IS
 *  re-rendered every following turn. */
const DAY_NOTE_LINE_MAX_LEN = 400;

/** The recurrence vocabulary (spec § E, contract §1.2) as a runtime list, so the parser checks the
 *  same three tags the type names. Order is the prompt's order. */
const RECURRENCE_TAGS: readonly Recurrence[] = ['once', 'periodic', 'ritual'];

export class ProdAgentPlayerGateway implements AgentPlayerGateway {
  private apiKey: string;
  private model: string;
  private temperature: number;
  private fetchFn: typeof fetch;
  private recorder?: LlmCallRecorder;
  private systemPrompt: string;
  private verbose: boolean;
  /** Stamps `llm_calls.promptVersion`: `agent-v2`, or `agent-v2/<persona>` when set. */
  private persona?: string;

  constructor(config: ProdAgentPlayerGatewayConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_LLM_MODEL;
    this.temperature = config.temperature ?? 0.7;
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.recorder = config.recorder;
    this.persona = config.persona;
    // The v2 set fires as a unit: the move-picker's instruction, the first-time-player handbook
    // every brain carries, and (when a persona is set) its fragment. Unset adds nothing at all, so
    // the persona-less prompt stays exactly what T2 shipped. `loadPersonaFragment` also validates
    // the name, so a bad one fails here rather than as a stamped row nobody can attribute.
    this.systemPrompt =
      config.systemPrompt ?? [loadBrainPrompt(), loadHandbookPrompt(), ...personaFragments(config.persona)].join('\n\n');
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
    let notes: ResolvedNotes = { droppedNotes: [] };

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

      let raw: RawBrainReply;
      try {
        const parsed: unknown = JSON.parse(content);
        // A body that parses but is not an object (`null`, a bare number, an array) is not a reply
        // at all: the note half must not be asked to read fields off it, and the move half's own
        // failure is the accurate diagnosis (`choice undefined is not a legal move index`).
        raw = isPlainObject(parsed) ? (parsed as RawBrainReply) : {};
      } catch {
        throw new Error(`ProdAgentPlayerGateway: failed to parse OpenRouter response: ${content.slice(0, 200)}`);
      }
      parseOk = true;

      // Notes first: a turn whose MOVE then throws still reports the notes it dropped in the
      // audit row, which is the only trace of that reply (the turn itself is discarded).
      notes = resolveNotes(raw);

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
            promptVersion: agentPlayerStamp(this.persona),
            callKind: CALL_KIND,
            model: this.model,
            temperature: this.temperature,
            tier: 0,
            playerInput: input.screenText,
            contextDigest: buildContextDigest(input),
            responseJson: parseOk ? content : null,
            parseOk,
            validationWarnings: notes.droppedNotes,
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
    return {
      move,
      // Each note is spread in only when it survived: an omitted or dropped field stays ABSENT
      // (never an explicit `undefined`), so a turn with no notes serialises as the bare `{ move }`
      // every pre-persona call site and test expects.
      ...(notes.intent !== undefined ? { intent: notes.intent } : {}),
      ...(notes.arcNote !== undefined ? { arcNote: notes.arcNote } : {}),
      ...(notes.friction !== undefined ? { friction: notes.friction } : {}),
      ...(notes.dayNote !== undefined ? { dayNote: notes.dayNote } : {}),
      ...(notes.droppedNotes.length > 0 ? { droppedNotes: notes.droppedNotes } : {}),
    };
  }
}

/** The persona fragment as a zero-or-one-element list, so the system prompt is assembled from one
 *  spread instead of a branch. No persona = no extra text, which is the baseline arm's prompt. */
function personaFragments(persona?: string): string[] {
  return persona ? [loadPersonaFragment(persona)] : [];
}

/** Map the brain's `{ choice, text }` reply to a concrete legal `AgentMove`. Throws loudly on an
 *  out-of-range choice or a free-text move with no text — the same "fail visibly" contract as the
 *  pipeline gateway's parse step. */
function resolveMove(raw: RawBrainReply, input: ChooseMoveInput): AgentMove {
  const choice = Number(raw.choice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= input.moves.length) {
    throw new Error(
      `ProdAgentPlayerGateway: choice ${JSON.stringify(raw.choice)} is not a legal move index ` +
        `(0..${input.moves.length - 1})`,
    );
  }
  const picked = input.moves[choice].move;
  if (picked.kind === 'custom') {
    const text = collapseText(raw.text);
    if (text === '') {
      throw new Error('ProdAgentPlayerGateway: chose a free-text action but returned no text');
    }
    return { kind: 'custom', text };
  }
  return picked;
}

/**
 * Resolve the reply's NOTE half (spec § E, contract §1.2). The degrade rule is the whole point: a
 * malformed MOVE throws (see `resolveMove`), a malformed NOTE never does — that one field is
 * dropped, a one-line reason naming it is pushed onto `droppedNotes`, and the turn comes back with
 * its move intact. A live run has already spent tokens by the time this runs, so a lost data point
 * must be visible in the transcript without killing the run. An ABSENT field is not a drop: omitted
 * means "unchanged" (intent/arc note) or "nothing to report" (friction/day note).
 */
function resolveNotes(raw: RawBrainReply): ResolvedNotes {
  const droppedNotes: string[] = [];
  /** Collect one field: absent (undefined check) means unchanged, a failed check pushes its one
   *  reason and drops the field, a pass yields the value. */
  const take = <T>(checked: Checked<T> | undefined): T | undefined => {
    if (checked === undefined) return undefined;
    if (!checked.ok) {
      droppedNotes.push(checked.reason);
      return undefined;
    }
    return checked.value;
  };
  return {
    intent: take(checkLine(raw.intent, 'intent')),
    arcNote: take(checkLine(raw.arcNote, 'arcNote')),
    friction: take(checkFriction(raw.friction, 'friction')),
    dayNote: take(checkDayNote(raw.dayNote, 'dayNote')),
    droppedNotes,
  };
}

/** A validated field: either the value, or the single one-line reason it was rejected. `undefined`
 *  (returned by the checkers instead of a `Checked`) means the field was absent, not malformed. */
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A one-line note (`intent`, `arcNote`, `friction.what`, a day note's strings): a present,
 *  non-empty string, whitespace-collapsed and length-capped. Collapsing is not cosmetic — these
 *  lines are re-rendered into the next turn's prompt, so un-collapsed multi-line text lets a reply
 *  inject its own section headers and grow the prompt every turn. The cap is the second half of that
 *  protection, aimed at runaway growth rather than at prose: like trimming, it is NORMALISATION, so
 *  a cut value is still the brain's note and is reported as nothing. `maxLen` is a parameter only so
 *  the day note's `line` can take `DAY_NOTE_LINE_MAX_LEN`; the value still has to pass the same
 *  checks, so a malformed line still drops and is still named. */
function checkLine(value: unknown, field: string, maxLen: number = TEXT_MAX_LEN): Checked<string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return { ok: false, reason: `${field}: expected a string, got ${preview(value)}` };
  const text = collapse(value, maxLen);
  if (text === '') return { ok: false, reason: `${field}: expected a non-empty string` };
  return { ok: true, value: text };
}

/** Whitespace-collapsed, length-capped free text — the shape every brain-authored string is accepted
 *  in. The cap is silent by design: the ellipsis the caller renders is the whole record of the cut. */
function collapse(value: string, maxLen: number = TEXT_MAX_LEN): string {
  const flat = value.trim().replace(/\s+/g, ' ');
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen).trimEnd()}…`;
}

/** The same shaping for a custom action's free text, which is not a validated NOTE (so it has no
 *  `droppedNotes` channel): '' when the reply carried no usable text, which the caller throws on. */
function collapseText(value: unknown): string {
  return typeof value === 'string' ? collapse(value) : '';
}

/** Inside `friction`/`dayNote` a MISSING key is not "absent, leave it alone" (that only holds for
 *  the four top-level note fields) — there is no shape the harness can honour without it, so it is
 *  dropped like any other bad value. */
function missingLine(field: string): Checked<string> {
  return { ok: false, reason: `${field}: expected a string, got nothing` };
}

/** A friction report (spec § E): `what` a non-empty string, `severity` a whole number 1..5, and
 *  `recurrence` one of the three tags. The recurrence tag is the measurement, not metadata — the
 *  panel weights a friction by projected exposure over a campaign — so an unknown tag drops the
 *  report rather than being coerced into a tag it is not. */
function checkFriction(value: unknown, field: string): Checked<FrictionReport> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    return { ok: false, reason: `${field}: expected an object, got ${preview(value)}` };
  }
  const what = checkLine(value.what, `${field}.what`) ?? missingLine(`${field}.what`);
  if (!what.ok) return what;
  const severity = rating(value.severity);
  if (severity === undefined) {
    return { ok: false, reason: `${field}: severity must be a whole number 1-5, got ${preview(value.severity)}` };
  }
  const recurrence = asRecurrence(value.recurrence);
  if (recurrence === undefined) {
    return {
      ok: false,
      reason: `${field}: recurrence must be once, periodic or ritual, got ${preview(value.recurrence)}`,
    };
  }
  return { ok: true, value: { what: what.value, severity, recurrence } };
}

/** The end-of-day note (spec § E): the rating pair plus the day's line and the updated arc note.
 *  Held to the `brain.md` shape exactly — a half-filled note is dropped whole, because the panel
 *  reads the rating pair and the arc note together. `line` is the one field that gets the wider cap
 *  (see `DAY_NOTE_LINE_MAX_LEN`); `arcNote` is a per-turn field and stays at `TEXT_MAX_LEN`. */
function checkDayNote(value: unknown, field: string): Checked<DayNote> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    return { ok: false, reason: `${field}: expected an object, got ${preview(value)}` };
  }
  const engagement = rating(value.engagement);
  if (engagement === undefined) {
    return {
      ok: false,
      reason: `${field}: engagement must be a whole number 1-5, got ${preview(value.engagement)}`,
    };
  }
  const fulfilment = rating(value.fulfilment);
  if (fulfilment === undefined) {
    return {
      ok: false,
      reason: `${field}: fulfilment must be a whole number 1-5, got ${preview(value.fulfilment)}`,
    };
  }
  const line = checkLine(value.line, `${field}.line`, DAY_NOTE_LINE_MAX_LEN) ?? missingLine(`${field}.line`);
  if (!line.ok) return line;
  const arcNote = checkLine(value.arcNote, `${field}.arcNote`) ?? missingLine(`${field}.arcNote`);
  if (!arcNote.ok) return arcNote;
  return { ok: true, value: { engagement, fulfilment, line: line.value, arcNote: arcNote.value } };
}

/** A 1..5 rating: a whole number in range, or `undefined` (the caller names the field it dropped).
 *  A stringified number is NOT accepted — `brain.md` asks for a number, JSON mode can deliver one,
 *  and coercing here would hide a prompt the model keeps misreading. */
function rating(value: unknown): 1 | 2 | 3 | 4 | 5 | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) return undefined;
  return value as 1 | 2 | 3 | 4 | 5;
}

/** The recurrence tag, matched against the runtime vocabulary so the parser and the type cannot
 *  drift. Written as a loop rather than a cast so the union narrows on evidence. */
function asRecurrence(value: unknown): Recurrence | undefined {
  for (const tag of RECURRENCE_TAGS) {
    if (tag === value) return tag;
  }
  return undefined;
}

/** A JSON object (`null` and arrays are not). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The offending value, one line, for a drop reason — truncated so a whole reply pasted into the
 *  wrong field cannot blow up the transcript. A string keeps its quotes so `"3"` (a string) reads
 *  differently from `3` (a number) in a reason that rejects one of them. */
function preview(value: unknown): string {
  if (value === undefined) return 'nothing';
  const text = typeof value === 'string' ? `"${value}"` : (JSON.stringify(value) ?? String(value));
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}...` : flat;
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
  if (input.lastRoll) {
    sections.push("LAST ROLL: this is the day's final action; include your dayNote with this pick.", '');
  }

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
