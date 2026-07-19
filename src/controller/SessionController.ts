/**
 * Transport-neutral session controller (JSON-seam M3, see
 * docs/engine/json-seam-build-plans.md). This is the first real controller slice — it holds
 * the engine and produces `ViewState` for the surfaces it owns. Imports ONLY
 * `type { WorldEngine }` and view-state types — **never `discord.js`** — that non-import is
 * the controller's structural guarantee: it stays reusable by any future medium (Discord
 * today, an agent adapter later) without dragging transport concerns in. Stateless in M3.1:
 * session state is engine-owned (parent decision 1), so this class is a thin pass-through
 * that later slices extend as the seam grows.
 */

import type { WorldEngine, CharacterData, PendingChoiceSelector } from '../engine/WorldEngine.js';
import type { NoticeViewState, DecisionViewState, OutcomeViewState } from '../view/viewState.js';
import { buildDecisionView, buildOutcomeView } from '../view/actionViewState.js';

export type FeedbackSurface = 'sleep' | 'release' | 'outcome-feedback' | 'outcome-bug';

/** Outcome of the `getCharacter` guard the pre-M3.2 button handler ran BEFORE deferring —
 *  split out from choice resolution (M3.2c) so the adapter can defer unconditionally right
 *  after this guard, matching the old ordering: guard → defer → parse customId. */
export type BeginChoiceResult =
  | { kind: 'no-character' }
  | { kind: 'ok'; character: CharacterData };

/** Outcome of stepping the action machine with a resolved label (M3.2 DC-C) — mirrors the
 *  pre-M3.2 button handler's step + outcome-render logic exactly: `decision` and `outcome`
 *  carry everything the adapter needs to paint without touching the engine again. Carries
 *  no `error` arm (M3.2c) — `stepAction`/view-build errors propagate to the caller so a
 *  single inner try/catch can cover step + paint + broadcast + announceCollapse, exactly
 *  like the pre-M3.2 handler's one inner try. */
export type StepChoiceResult =
  | { kind: 'decision'; view: DecisionViewState }
  | { kind: 'outcome'; view: OutcomeViewState; distilledType: string; actionId?: number; characterName: string; characterClass?: string | null; char: CharacterData | null; prevChar: CharacterData };

export class SessionController {
  constructor(
    private readonly engine: WorldEngine,
    private readonly getCurrentScene: (userId: string) => string,
  ) {}

  /** The `getCharacter` guard alone (M3.2c) — the pre-M3.2 handler ran this BEFORE
   *  `deferUpdate`, and only this; the customId parse and choice resolution both
   *  happened AFTER the defer, so they're split into `resolveChoice` below. */
  beginChoice(userId: string): BeginChoiceResult {
    const character = this.engine.getCharacter(userId);
    if (!character) return { kind: 'no-character' };
    return { kind: 'ok', character };
  }

  /** Resolves the clicked option/bail button against the engine's own pending-decision
   *  state (M3.2 DC-A) — a thin pass-through to `engine.resolvePendingChoice`, called
   *  AFTER `deferUpdate` (mirrors the pre-M3.2 handler's ordering). */
  resolveChoice(character: CharacterData, selector: PendingChoiceSelector): string | null {
    return this.engine.resolvePendingChoice(character.id, selector);
  }

  /** Steps the action machine with the resolved label — mirrors the pre-M3.2 button
   *  handler's step + apply-result logic exactly (same re-read-after-step, same
   *  NOT-compact outcome view, same scene source). Does NOT catch: `stepAction`/view-build
   *  errors propagate so the adapter's single inner try can cover step + paint + broadcast
   *  + announceCollapse, exactly like the pre-M3.2 handler's one inner try/catch. */
  async stepChoice(userId: string, label: string, prevChar: CharacterData): Promise<StepChoiceResult> {
    const result = await this.engine.stepAction(prevChar.id, label);
    if (result.resolved) {
      const char = this.engine.getCharacter(userId);
      const view = buildOutcomeView(result.outcome, char, this.getCurrentScene(userId), result.state, undefined, this.engine);
      return {
        kind: 'outcome',
        view,
        distilledType: result.outcome.distilledType,
        actionId: result.outcome.actionId,
        characterName: char?.name ?? 'Unknown',
        characterClass: char?.class,
        char,
        prevChar,
      };
    }
    const char = this.engine.getCharacter(userId);
    const view = buildDecisionView(result.nextDecision, result.state.decisions.length, result.state, char ?? undefined);
    return { kind: 'decision', view };
  }

  /** The confirmation copy for a feedback/bug submission — a pure function of the surface, so it
   *  can be shown BEFORE the best-effort persist (preserving reply-first resilience). */
  feedbackConfirmation(surface: FeedbackSurface): NoticeViewState {
    const text =
      surface === 'outcome-bug' ? '🐛 Bug noted. The warden will investigate.'
      : surface === 'release'   ? '🙏 Noted. The warden carries your words forward.'
      : '🙏 Thanks. The warden listens.';
    return { screen: 'notice', text, ephemeral: true };
  }

  /** Best-effort persist. No character → no-op (matches the current `if (char)` guard). Passes an
   *  actionId only for the outcome surfaces, matching each leaf's current arg count exactly. */
  recordFeedback(surface: FeedbackSurface, userId: string, text: string, actionId?: number): void {
    const char = this.engine.getCharacter(userId);
    if (!char) return;
    switch (surface) {
      case 'outcome-bug': this.engine.submitBug(char.id, text, actionId); break;
      case 'outcome-feedback': this.engine.submitFeedback(char.id, text, actionId); break;
      default: this.engine.submitFeedback(char.id, text); break; // sleep, release — no actionId
    }
  }
}
