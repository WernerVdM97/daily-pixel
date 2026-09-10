import type { CharCreateData } from "../engine/WorldEngine.js";

/**
 * In-memory wizard state for character creation.
 * Lives only until confirm — no DB row until character is created.
 */

export interface WizardState {
  discordUserId: string;
  step: number; // 1=name, 2=class, 3=upbringing, 4=race, 5=alignment, 6=dayJob, 7=itemSet, 8=confirm
  name?: string;
  class?: string;
  upbringing?: string;
  race?: string;
  alignment?: string;
  dayJob?: string;
  itemSet?: string;
  startedAt: Date;
}

const NAME_MIN = 2;
const NAME_MAX = 30;
const NAME_INVALID_RE = /[@#]/;

const STEP_LABELS: Record<number, string> = {
  1: "name",
  2: "class",
  3: "upbringing",
  4: "race",
  5: "alignment",
  6: "dayJob",
  7: "itemSet",
};

export class WizardSession {
  private sessions = new Map<string, WizardState>();
  private ttlMs: number;

  constructor(ttlMs: number = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Start a new wizard session at step 1.
   * Throws if the user already has an active (non-expired) session.
   */
  start(discordUserId: string): WizardState {
    const existing = this.sessions.get(discordUserId);
    if (existing && !this.isExpired(discordUserId)) {
      throw new Error(
        `User ${discordUserId} is already in a wizard session at step ${existing.step}`,
      );
    }

    const state: WizardState = {
      discordUserId,
      step: 1,
      startedAt: new Date(),
    };
    this.sessions.set(discordUserId, state);
    return { ...state };
  }

  /**
   * Set the character name (step 1) and advance to step 2.
   */
  setName(discordUserId: string, name: string): WizardState {
    const state = this.getOrThrow(discordUserId);
    if (state.step !== 1) {
      throw new Error(`Expected step 1 (name), got step ${state.step}`);
    }
    this.validateName(name);
    state.name = name.trim();
    state.step = 2;
    return { ...state };
  }

  /**
   * Record a choice for the current step and advance.
   * @param expectedStep The step this choice should be for (safety check).
   * @param field The state field to set (class, upbringing, race, alignment, dayJob).
   * @param choice The value chosen.
   */
  choose(
    discordUserId: string,
    expectedStep: number,
    field: keyof Pick<
      WizardState,
      "class" | "upbringing" | "race" | "alignment" | "dayJob" | "itemSet"
    >,
    choice: string,
  ): WizardState {
    const state = this.getOrThrow(discordUserId);
    if (state.step !== expectedStep) {
      throw new Error(
        `Expected step ${expectedStep} (${STEP_LABELS[expectedStep]}), got step ${state.step}`,
      );
    }
    (state as unknown as Record<string, unknown>)[field] = choice;
    state.step = expectedStep + 1;
    return { ...state };
  }

  /**
   * Confirm character creation. Returns the CharCreateData and clears the session.
   */
  confirm(discordUserId: string): CharCreateData {
    const state = this.getOrThrow(discordUserId);
    if (state.step !== 8) {
      throw new Error(
        `Cannot confirm: expected step 8, got step ${state.step}`,
      );
    }

    const data: CharCreateData = {
      name: state.name!,
      class: state.class!,
      upbringing: state.upbringing!,
      race: state.race!,
      alignment: state.alignment!,
      dayJob: state.dayJob!,
      itemSetName: state.itemSet,
    };

    this.sessions.delete(discordUserId);
    return data;
  }

  /**
   * Get the current session state, or undefined if none exists.
   */
  getSession(discordUserId: string): WizardState | undefined {
    const state = this.sessions.get(discordUserId);
    if (!state) return undefined;
    return { ...state };
  }

  /**
   * Check if the session has expired (10 min TTL by default).
   */
  isExpired(discordUserId: string): boolean {
    const state = this.sessions.get(discordUserId);
    if (!state) return false;
    return Date.now() - state.startedAt.getTime() > this.ttlMs;
  }

  /**
   * Clear the session for a user. Safe to call even if none exists.
   */
  reset(discordUserId: string): void {
    this.sessions.delete(discordUserId);
  }

  // ── private ──

  private getOrThrow(discordUserId: string): WizardState {
    const state = this.sessions.get(discordUserId);
    if (!state) {
      throw new Error(`No wizard session found for user ${discordUserId}`);
    }
    if (this.isExpired(discordUserId)) {
      this.sessions.delete(discordUserId);
      throw new Error(`Wizard session expired for user ${discordUserId}`);
    }
    return state;
  }

  private validateName(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) {
      throw new Error(`Name must be ${NAME_MIN}-${NAME_MAX} characters`);
    }
    if (NAME_INVALID_RE.test(trimmed)) {
      throw new Error("Name must not contain @ or # (Discord pings)");
    }
  }
}
