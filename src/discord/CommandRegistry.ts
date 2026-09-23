/**
 * The nav-button facts a handler hands back for the dispatcher's nav-bar weld — structurally
 * the `facts.nav` the router puts on a character's view-bearing envelope.
 */
export type NavFacts = {
  rollsRemaining: number;
  hasPendingAction: boolean;
  hasRestedToday: boolean;
};

/**
 * `onNav` is optional: a handler that takes fewer parameters stays assignable to this type, so
 * only the ones that hand `facts.nav` back opt in.
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
