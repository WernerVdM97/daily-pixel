/**
 * The nav-button facts a handler hands back for the dispatcher's nav-bar weld (DC-M9.6).
 * Structurally the `facts.nav` the router puts on every view-bearing envelope.
 */
export type NavFacts = {
  rollsRemaining: number;
  hasPendingAction: boolean;
  hasRestedToday: boolean;
};

/**
 * DC-M9.6: `onNav` is how a handler's `facts.nav` reaches the dispatcher, which paints the
 * nav bar a moment after the handler returns and must not read the engine itself. A handler
 * that takes fewer parameters stays assignable to this type, so every direct caller (tests,
 * the join-confirm `/hi` render, the nav leaves) compiles unchanged and only the handlers
 * that actually cross the seam opt in.
 */
export type CommandHandler = (
  interaction: unknown,
  onNav?: (nav: NavFacts | undefined) => void,
) => Promise<string>;

export class CommandRegistry {
  private commands = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler): void {
    if (this.commands.has(name)) {
      throw new Error(`Command "${name}" is already registered.`);
    }
    this.commands.set(name, handler);
  }

  get(name: string): CommandHandler | undefined {
    return this.commands.get(name);
  }

  commandNames(): string[] {
    return Array.from(this.commands.keys());
  }
}
