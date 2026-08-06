/**
 * The M5 JSON-seam input events (M5.0 — DC-P2; see docs/engine/json-seam-protocol.md): the
 * discriminated union the router's `dispatch(event: unknown, …)` consumes. `playerId` is
 * opaque by design — today it happens to be a Discord user id, but the protocol must not
 * care. The union grows only in the slice that first needs each event (no unused vocabulary
 * ahead of a caller). `bug.submit` maps to the controller's `'outcome-bug'` surface, so the
 * protocol surface set for `feedback.submit` deliberately excludes it.
 *
 * `validateGameEvent` is the hand-rolled, throw-loud-convention gate the router runs BEFORE
 * any dispatch (DC-P3): malformed payloads never reach the controller, so the negative-space
 * barrier (malformed → `ok: false 'invalid-event'`, never a throw) is structural, not a test
 * hope. Shape checks only — range/state checks (e.g. an out-of-bounds `jobIndex` against the
 * day-job list) are the router's job and map to `'illegal-move'`, per DC-P4.
 */

export type GameEvent =
  | { type: 'menu.open'; playerId: string }
  | { type: 'dayjob.start'; playerId: string; jobIndex: number }
  | { type: 'action.custom'; playerId: string; text: string }
  | { type: 'action.choose'; playerId: string; selector: { kind: 'option'; index: number } | { kind: 'bail' } }
  | { type: 'feedback.submit'; playerId: string; surface: 'sleep' | 'release' | 'outcome-feedback'; text: string; actionId?: number }
  | { type: 'bug.submit'; playerId: string; text: string; actionId?: number }
  | { type: 'rest.begin'; playerId: string }
  | { type: 'hi.open'; playerId: string }
  | { type: 'join.open'; playerId: string }
  | { type: 'wizard.answer'; playerId: string; text: string }
  | { type: 'wizard.choose'; playerId: string; step: number; value: string }
  | { type: 'wizard.restart'; playerId: string }
  | { type: 'character.create'; playerId: string }
  // M8.1 (DC-M8.1): the six read-only screens cross the seam as flat `screen.*` events
  // (names pinned for M8.5's parity beats). `screen.map` carries an optional `focus` — the
  // slash-arm drill-down — empty-string allowed (the registry's `getString("place") ??
  // undefined` can hand `''`, which today renders the full map); a non-string focus is
  // malformed (shape check only, DC-P3).
  | { type: 'screen.look'; playerId: string }
  | { type: 'screen.map'; playerId: string; focus?: string }
  | { type: 'screen.stats'; playerId: string }
  | { type: 'screen.backpack'; playerId: string }
  | { type: 'screen.journal'; playerId: string }
  | { type: 'screen.help'; playerId: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0;

/** `screen.map`'s optional `focus` is plain-string-typed (empty allowed — see the union). */
const isString = (value: unknown): boolean => typeof value === 'string';

/** `jobIndex` and selector indices are array positions — negative or fractional positions
 *  are malformed, not "illegal moves"; the router decides whether the position exists. */
const isNonNegativeInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Present-but-invalid vs absent are distinguished on purpose: `actionId` is optional, and
 *  when supplied it must be a real outcome id — 0 and negatives are malformed. */
const isPositiveInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

export function validateGameEvent(raw: unknown): { ok: true; event: GameEvent } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: 'event must be a plain object' };
  if (!isNonEmptyString(raw.playerId)) return { ok: false, message: 'playerId must be a non-empty string' };

  switch (raw.type) {
    case 'menu.open':
      return { ok: true, event: raw as unknown as GameEvent };
    case 'rest.begin':
      return { ok: true, event: raw as unknown as GameEvent };
    case 'hi.open':
      return { ok: true, event: raw as unknown as GameEvent };
    case 'join.open':
    case 'wizard.restart':
    case 'character.create':
    case 'screen.look':
    case 'screen.stats':
    case 'screen.backpack':
    case 'screen.journal':
    case 'screen.help':
      return { ok: true, event: raw as unknown as GameEvent };
    case 'screen.map':
      if (raw.focus !== undefined && !isString(raw.focus)) {
        return { ok: false, message: 'focus must be a string when present' };
      }
      return { ok: true, event: raw as unknown as GameEvent };
    case 'wizard.answer':
      if (!isNonEmptyString(raw.text)) return { ok: false, message: 'text must be a non-empty string' };
      return { ok: true, event: raw as unknown as GameEvent };
    case 'wizard.choose':
      if (!isNonNegativeInteger(raw.step)) return { ok: false, message: 'step must be a non-negative integer' };
      if (!isNonEmptyString(raw.value)) return { ok: false, message: 'value must be a non-empty string' };
      return { ok: true, event: raw as unknown as GameEvent };
    case 'dayjob.start':
      if (!isNonNegativeInteger(raw.jobIndex)) {
        return { ok: false, message: 'jobIndex must be a non-negative integer' };
      }
      return { ok: true, event: raw as unknown as GameEvent };
    case 'action.custom':
      if (!isNonEmptyString(raw.text)) return { ok: false, message: 'text must be a non-empty string' };
      return { ok: true, event: raw as unknown as GameEvent };
    case 'action.choose': {
      const selector = raw.selector;
      if (!isRecord(selector) || (selector.kind !== 'option' && selector.kind !== 'bail')) {
        return { ok: false, message: "selector must be { kind: 'option'; index } or { kind: 'bail' }" };
      }
      if (selector.kind === 'option' && !isNonNegativeInteger(selector.index)) {
        return { ok: false, message: 'selector.index must be a non-negative integer' };
      }
      return { ok: true, event: raw as unknown as GameEvent };
    }
    case 'feedback.submit':
    case 'bug.submit': {
      if (!isNonEmptyString(raw.text)) return { ok: false, message: 'text must be a non-empty string' };
      if (raw.type === 'feedback.submit'
        && raw.surface !== 'sleep' && raw.surface !== 'release' && raw.surface !== 'outcome-feedback') {
        return { ok: false, message: "surface must be one of 'sleep' | 'release' | 'outcome-feedback'" };
      }
      if (raw.actionId !== undefined && !isPositiveInteger(raw.actionId)) {
        return { ok: false, message: 'actionId must be a positive integer when present' };
      }
      return { ok: true, event: raw as unknown as GameEvent };
    }
    default:
      return { ok: false, message: `unknown event type "${String(raw.type)}"` };
  }
}
