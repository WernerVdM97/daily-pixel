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

/** A transient "please wait" screen — one plain grey embed, no buttons. Used between staged
 *  controller steps (e.g. the day-job work flow's "Starting…" beat) where the caller has
 *  already deferred/replied and just needs to paint an interstitial while a later step runs. */
export interface LoadingViewState {
  screen: 'loading';
  body: string;
}

/** The day-job work flow's transient commute beat — folds the "you moved" beat INTO the
 *  loading indicator (idle message carried over) so the multi-second LLM call underneath
 *  still reads as "in progress", not stalled. */
export interface CommuteViewState {
  screen: 'commute';
  destination: string;
  idle: string;
}

/** The character-creation wizard screen (M7.3, DC-M7.3.3) — the join walk's step screen
 *  carried semantically across the seam. Pure strings pre-rendered (byte-identity with the
 *  pre-seam buildStepMessage assembly), interactive/data parts semantic. The embed chrome
 *  (title ⚔️  Forge Your Hero, goldenrod, Oak thumbnail/files) and the button customIds +
 *  styles stay in the medium step. The wizard envelope carries NO character facts — the
 *  walk's user has no character (DC-M6.1's null-char rule). */
export interface WizardViewState {
  screen: 'wizard';
  /** 1-8; 8 = the confirm review screen. */
  step: number;
  /** The walk has 7 option steps (step 8 is the review). */
  totalSteps: number;
  /** Pre-rendered progress ledger (one line per step; ◀ marker; struck-through chosen
   *  values with the option's own emoji). */
  ledger: string;
  /** Pre-rendered body block: step prompt + option list (steps 2-7), the name prompt
   *  (step 1), the ready prose (step 8). */
  body: string;
  footer: string;
  /** Step 1 only — the modal the adapter welds (customIds are medium chrome). */
  nameField?: { label: string; placeholder: string; minLength: number; maxLength: number };
  /** Steps 2-7 only — value is the persisted key, label the display, emoji from the defs
   *  (FALLBACK_EMOJI "🔹" when absent). */
  options?: Array<{ value: string; label: string; emoji?: string }>;
  /** Semantic buttons the adapter welds (customIds + styles + chunking are medium chrome). */
  buttons: Array<
    | { kind: 'name'; label: string; emoji: string }
    | { kind: 'choice'; step: number; value: string; label: string; emoji?: string }
    | { kind: 'confirm'; label: string; emoji: string }
    | { kind: 'restart'; label: string; emoji: string }
  >;
}

export type ViewState = DecisionViewState | OutcomeViewState | NoticeViewState | MenuViewState | LoadingViewState | CommuteViewState | WizardViewState;
