/**
 * Semantic view-state DTOs for the /action decision and outcome screens. Transport-neutral: no
 * `discord.js` import, and the structural test bans this layer importing `src/discord/` at runtime.
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
  /** Optional on the wire (`buildOutcomeView` always renders it; the protocol stub's fixed
   *  sample omits it), so `outcomeViewToDiscord`/`viewToText` keep their presence guard. */
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

/** The day-job action menu — one embed + one button row. `style` is `'secondary' | 'primary'`
 *  only: this screen has no bail/favoured concept, unlike `DecisionButtonItem`. */
export interface MenuViewState {
  screen: 'menu';
  title: { emoji: string; text: string };
  description: string;
  buttons: Array<{ label: string; customId: string; style: 'secondary' | 'primary' }>;
}

/** A transient "please wait" screen — one plain grey embed, no buttons, painted between staged
 *  controller steps where the caller has already deferred and a later step is still running. */
export interface LoadingViewState {
  screen: 'loading';
  body: string;
}

/** The day-job commute beat — folds "you moved" into the loading indicator so the multi-second
 *  LLM call underneath still reads as in-progress, not stalled. */
export interface CommuteViewState {
  screen: 'commute';
  destination: string;
  idle: string;
}

/** The character-creation wizard screen — the join walk's step screen carried semantically across
 *  the seam; chrome and customIds stay in the medium step, and the envelope carries no character facts. */
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
