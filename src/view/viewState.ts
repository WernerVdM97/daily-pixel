/**
 * Semantic view-state DTOs for the /action decision and outcome screens (JSON-seam M2,
 * see docs/engine/json-seam-build-plans.md). Transport-neutral: no discord.js import, no
 * runtime code — that non-import is the structural guarantee these types stay presentation
 * data, not a Discord-shaped payload. `src/discord/viewToDiscord.ts` is the sole medium step
 * that maps a `ViewState` into embed/component JSON.
 */

/** Semantic colour choice — the medium step maps this to a Discord embed hex. */
export type ViewColorIntent =
  | 'decision'
  | 'success'
  | 'failure'
  | 'skipped'
  | 'bailed'
  | 'done'
  | 'timed_out'
  | 'default';

/** Mirrors the current `ButtonBuilder` set 1:1 — a lettered real option ("choice") or the
 *  worded terminal option ("bail"). */
export type DecisionButtonItem =
  | { kind: 'choice'; letter: string; customId: string; favoured: boolean }
  | { kind: 'bail'; label: string; customId: string };

export interface DecisionViewState {
  screen: 'decision';
  title: { emoji: string; text: string };
  colorIntent: 'decision';
  /** Both variants pre-rendered so the medium step can re-run the exact same degrade
   *  decision (full → collapsed) against pre-rendered strings, byte-identically. */
  storyThread?: { full: string; collapsed: string };
  narration?: string;
  combatStatus?: string;
  prompt: string;
  optionLines: string[];
  buttons: DecisionButtonItem[];
  footer: string;
  openingFrame?: string;
}

export interface OutcomeViewState {
  screen: 'outcome';
  title: { emoji: string; text: string };
  colorIntent: ViewColorIntent;
  locationLine?: string;
  breadcrumb?: string;
  sceneBlock?: string;
  combatSceneBlock?: string;
  /** Selects `combatSceneBlock` over `sceneBlock` when the medium step includes the scene. */
  isCombat: boolean;
  /** Absent when the caller asked for `opts.compact` (the current `!compact` guard). */
  storyThread?: { full: string; collapsed: string };
  outcomeBlock: string;
}

/** A plain confirmation/notice screen — no embed, just content. The medium step maps it to a
 *  Discord reply payload; an agent adapter reads `text` directly. */
export interface NoticeViewState {
  screen: 'notice';
  text: string;
  ephemeral: boolean;
}

/** The day-job action menu — one embed + one button row. The medium step maps `style`
 *  intent to `ButtonStyle` ('secondary' | 'primary' only — this screen has no bail/favoured
 *  concept, unlike `DecisionButtonItem`). */
export interface MenuViewState {
  screen: 'menu';
  title: { emoji: string; text: string };
  description: string;
  buttons: Array<{ label: string; customId: string; style: 'secondary' | 'primary' }>;
}

export type ViewState = DecisionViewState | OutcomeViewState | NoticeViewState | MenuViewState;
