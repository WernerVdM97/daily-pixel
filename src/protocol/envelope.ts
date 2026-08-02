/**
 * The JSON-seam response envelope (M5.0 — DC-P1, frozen; see docs/engine/json-seam-protocol.md).
 * `v` stamps every envelope with the protocol version so conformance is trivially assertable
 * and a future breaking change is detectable per message. Transport-neutral by the Home rule:
 * this module imports ONLY the ViewState type — nothing from discord.js, src/discord, or
 * src/agent — the same non-import trick that keeps viewState.ts presentation data.
 *
 * `validateGameResponse` is the hand-rolled barrier the M5.1 contract suite will run every
 * router emission through. It whitelists the `facts` keys (DC-P1: the escape hatch cannot
 * grow without a deliberate validator edit) and checks the view's screen discriminant, but
 * deliberately does NOT deep-clone or exhaustively schema-check views — the ViewState
 * builders are typed, so the validator exists to catch structural drift, not to re-derive
 * the DTOs.
 */

import type { ViewState } from '../view/viewState.js';

export const PROTOCOL_VERSION = 1;

export type GameErrorCode =
  | 'no-character' | 'no-rolls' | 'stale-session' | 'session-expired'
  | 'illegal-move' | 'unsafe' | 'empty-action' | 'invalid-event' | 'internal';

export type GameResponse =
  | { v: number; ok: true; view?: ViewState; facts?: Record<string, unknown> }
  | { v: number; ok: false; error: { code: GameErrorCode; message: string }; facts?: Record<string, unknown> };

/** The closed facts set (DC-P1). A key is added only when a consuming adapter justifies it —
 *  the validator rejects anything outside this set, which is what stops the "second
 *  protocol" escape hatch from growing silently. */
const FACTS_KEYS = new Set<string>(['distilledType', 'characterName', 'characterClass', 'actionId', 'nav', 'narration']);

const GAME_ERROR_CODES = new Set<GameErrorCode>(['no-character', 'no-rolls', 'stale-session', 'session-expired', 'illegal-move', 'unsafe', 'empty-action', 'invalid-event', 'internal']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isOptionalString = (value: unknown): boolean => value === undefined || isString(value);

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

/** View titles are `{ emoji, text }` — both strings — across every variant. */
const isTitle = (value: unknown): boolean =>
  isRecord(value) && isString(value.emoji) && isString(value.text);

const isOptionalStoryThread = (value: unknown): boolean =>
  value === undefined || (isRecord(value) && isString(value.full) && isString(value.collapsed));

/** JSON drops undefined and functions (stringify returns undefined), throws on
 *  bigints/circular refs — probing with stringify is the literal "is this field
 *  JSON-serialisable" check without cloning anything. */
const isJsonSerialisable = (value: unknown): boolean => {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
};

const isGameErrorCode = (value: unknown): value is GameErrorCode =>
  isString(value) && GAME_ERROR_CODES.has(value as GameErrorCode);

/** Structural check per variant: screen discriminant + required string fields are strings
 *  (+ the few required non-string primitives), optional fields type-checked when present.
 *  Nothing is cloned. */
const validateView = (view: unknown): boolean => {
  if (!isRecord(view) || !isString(view.screen)) return false;
  const screen = view.screen;
  switch (screen) {
    case 'decision':
      return isTitle(view.title)
        && isString(view.colorIntent)
        && isString(view.prompt)
        && isStringArray(view.optionLines)
        && Array.isArray(view.buttons)
        && isString(view.footer)
        && isOptionalStoryThread(view.storyThread)
        && isOptionalString(view.narration)
        && isOptionalString(view.combatStatus)
        && isOptionalString(view.openingFrame);
    case 'outcome':
      return isTitle(view.title)
        && isString(view.colorIntent)
        && typeof view.isCombat === 'boolean'
        && isString(view.outcomeBlock)
        && isOptionalString(view.locationLine)
        && isOptionalString(view.breadcrumb)
        && isOptionalString(view.sceneBlock)
        && isOptionalString(view.combatSceneBlock)
        && isOptionalStoryThread(view.storyThread);
    case 'notice':
      return isString(view.text) && typeof view.ephemeral === 'boolean';
    case 'menu':
      return isTitle(view.title) && isString(view.description) && Array.isArray(view.buttons);
    case 'loading':
      return isString(view.body);
    case 'commute':
      return isString(view.destination) && isString(view.idle);
    default:
      return false;
  }
};

export function validateGameResponse(raw: unknown): { ok: true; response: GameResponse } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: 'envelope must be a plain object' };
  if (raw.v !== PROTOCOL_VERSION) {
    return { ok: false, message: `envelope.v must equal PROTOCOL_VERSION (${PROTOCOL_VERSION})` };
  }
  if (typeof raw.ok !== 'boolean') return { ok: false, message: 'envelope.ok must be a boolean' };

  if (raw.facts !== undefined) {
    if (!isRecord(raw.facts)) return { ok: false, message: 'envelope.facts must be a plain object' };
    for (const key of Object.keys(raw.facts)) {
      if (!FACTS_KEYS.has(key)) return { ok: false, message: `unknown facts key "${key}"` };
      if (!isJsonSerialisable(raw.facts[key])) {
        return { ok: false, message: `facts.${key} must be JSON-serialisable` };
      }
    }
    // `nav` is the one structured fact — the exact three fields getNavButtons reads.
    if ('nav' in raw.facts) {
      const nav = raw.facts.nav;
      if (
        !isRecord(nav)
        || Object.keys(nav).length !== 3
        || typeof nav.rollsRemaining !== 'number'
        || typeof nav.hasPendingAction !== 'boolean'
        || typeof nav.hasRestedToday !== 'boolean'
      ) {
        return { ok: false, message: 'facts.nav must be exactly { rollsRemaining: number; hasPendingAction: boolean; hasRestedToday: boolean }' };
      }
    }
  }

  if (raw.ok) {
    if (raw.view !== undefined && !validateView(raw.view)) {
      return { ok: false, message: 'envelope.view is not a valid ViewState' };
    }
    return { ok: true, response: raw as unknown as GameResponse };
  }

  // ok: false — error.code + error.message are the only required members (facts already
  // checked above; the stale-session narration rides it).
  const error = raw.error;
  if (
    !isRecord(error)
    || !isGameErrorCode(error.code)
    || !isString(error.message)
    || error.message.length === 0
  ) {
    return { ok: false, message: 'error envelope must carry error: { code: GameErrorCode; message: string }' };
  }
  return { ok: true, response: raw as unknown as GameResponse };
}
