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
const FACTS_KEYS = new Set<string>(['distilledType', 'characterName', 'characterClass', 'actionId', 'nav', 'narration', 'characterState', 'restUnsafe', 'createdCharacter']);

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

/** Deep JSON-serialisability walk: rejects undefined, functions, symbols and
 *  bigints ANYWHERE in the value, not just at the top level — JSON.stringify
 *  silently DROPS a nested undefined/function/symbol and only signals trouble
 *  for a top-level one (returns undefined) or for bigints (throws), so probing
 *  with stringify would let a nested poison pass as "serialisable". Circular
 *  references blow the recursion and are caught by the try/catch below. */
const isJsonSerialisable = (value: unknown): boolean => {
  try {
    if (
      value === undefined
      || typeof value === 'function'
      || typeof value === 'symbol'
      || typeof value === 'bigint'
    ) {
      return false;
    }
    if (value === null || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.every(isJsonSerialisable);
    return Object.keys(value).every((key) => isJsonSerialisable((value as Record<string, unknown>)[key]));
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
    case 'wizard':
      return Number.isInteger(view.step)
        && Number.isInteger(view.totalSteps)
        && isString(view.ledger)
        && isString(view.body)
        && isString(view.footer)
        && Array.isArray(view.buttons)
        && view.buttons.every(b =>
          isRecord(b) && isString(b.kind) && isString(b.label) && (b.emoji === undefined || isString(b.emoji)))
        && (view.nameField === undefined || (
          isRecord(view.nameField)
          && isString(view.nameField.label)
          && isString(view.nameField.placeholder)
          && Number.isInteger(view.nameField.minLength)
          && Number.isInteger(view.nameField.maxLength)
        ))
        && (view.options === undefined || (
          Array.isArray(view.options)
          && view.options.every(o =>
            isRecord(o) && isString(o.value) && isString(o.label) && (o.emoji === undefined || isString(o.emoji)))
        ));
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
        || !Number.isInteger(nav.rollsRemaining)
        || typeof nav.hasPendingAction !== 'boolean'
        || typeof nav.hasRestedToday !== 'boolean'
      ) {
        return { ok: false, message: 'facts.nav must be exactly { rollsRemaining: number; hasPendingAction: boolean; hasRestedToday: boolean }' };
      }
    }
    // `characterState` — the agent brain's character snapshot (DC-M6.1). All six fields
    // required; health/maxHealth/stamina/maxStamina are non-negative integers; wealth is
    // an integer (no lower bound); location is a non-empty string.
    if ('characterState' in raw.facts) {
      const cs = raw.facts.characterState;
      if (!isRecord(cs)) {
        return { ok: false, message: 'facts.characterState must be a plain object' };
      }
      if (Object.keys(cs).length !== 6) {
        return { ok: false, message: 'facts.characterState must have exactly 6 keys' };
      }
      if (!Number.isInteger(cs.health) || (cs.health as number) < 0) {
        return { ok: false, message: 'facts.characterState.health must be a non-negative integer' };
      }
      if (!Number.isInteger(cs.maxHealth) || (cs.maxHealth as number) < 0) {
        return { ok: false, message: 'facts.characterState.maxHealth must be a non-negative integer' };
      }
      if (!Number.isInteger(cs.stamina) || (cs.stamina as number) < 0) {
        return { ok: false, message: 'facts.characterState.stamina must be a non-negative integer' };
      }
      if (!Number.isInteger(cs.maxStamina) || (cs.maxStamina as number) < 0) {
        return { ok: false, message: 'facts.characterState.maxStamina must be a non-negative integer' };
      }
      if (!Number.isInteger(cs.wealth)) {
        return { ok: false, message: 'facts.characterState.wealth must be an integer' };
      }
      if (!isString(cs.location) || cs.location.length === 0) {
        return { ok: false, message: 'facts.characterState.location must be a non-empty string' };
      }
    }
    // `restUnsafe` — the unsafe-rest −1 HP feedback (DC-M7.1.4): the actor's name plus the
    // prev/updated vitals, present ONLY on unsafe rested envelopes (consumers: the rewired
    // sleep.ts announceCollapse call and the agent harness's finding).
    if ('restUnsafe' in raw.facts) {
      const ru = raw.facts.restUnsafe;
      if (!isRecord(ru)) {
        return { ok: false, message: 'facts.restUnsafe must be a plain object' };
      }
      if (Object.keys(ru).length !== 3) {
        return { ok: false, message: 'facts.restUnsafe must have exactly 3 keys' };
      }
      if (!isString(ru.name) || ru.name.length === 0) {
        return { ok: false, message: 'facts.restUnsafe.name must be a non-empty string' };
      }
      const vitalsOk = (v: unknown): boolean =>
        isRecord(v)
        && Object.keys(v).length === 2
        && Number.isInteger(v.health) && (v.health as number) >= 0
        && Number.isInteger(v.stamina) && (v.stamina as number) >= 0;
      if (!vitalsOk(ru.prev)) {
        return { ok: false, message: 'facts.restUnsafe.prev must be { health: number; stamina: number }' };
      }
      if (!vitalsOk(ru.updated)) {
        return { ok: false, message: 'facts.restUnsafe.updated must be { health: number; stamina: number }' };
      }
    }
    // `createdCharacter` — the M7.3 confirm result (DC-M7.3.7): the exact CharCreateData
    // (name/class/upbringing/race/alignment/dayJob non-empty strings + optional
    // itemSetName; nothing else — consumer in-slice: the rewired join confirm handler's
    // public ✨ announcement).
    if ('createdCharacter' in raw.facts) {
      const cc = raw.facts.createdCharacter;
      if (!isRecord(cc)) {
        return { ok: false, message: 'facts.createdCharacter must be a plain object' };
      }
      if (!Object.keys(cc).every(k => ['name', 'class', 'upbringing', 'race', 'alignment', 'dayJob', 'itemSetName'].includes(k))) {
        return { ok: false, message: 'facts.createdCharacter carries an unknown key' };
      }
      for (const k of ['name', 'class', 'upbringing', 'race', 'alignment', 'dayJob']) {
        if (!isString(cc[k]) || (cc[k] as string).length === 0) {
          return { ok: false, message: `facts.createdCharacter.${k} must be a non-empty string` };
        }
      }
      if (cc.itemSetName !== undefined && !isString(cc.itemSetName)) {
        return { ok: false, message: 'facts.createdCharacter.itemSetName must be a string when present' };
      }
    }
  }

  if (raw.ok) {
    // ok:true envelopes must not smuggle the error arm's members across the seam
    if ('error' in raw) {
      return { ok: false, message: 'ok:true envelope must not carry an error field' };
    }
    if (raw.view !== undefined && !validateView(raw.view)) {
      return { ok: false, message: 'envelope.view is not a valid ViewState' };
    }
    return { ok: true, response: raw as unknown as GameResponse };
  }

  // ok: false — error.code + error.message are the only required members (facts already
  // checked above; the stale-session narration rides it), and the view arm's member
  // must not leak across the seam either.
  if ('view' in raw) {
    return { ok: false, message: 'ok:false envelope must not carry a view field' };
  }
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
