export type CommandHandler = (interaction: unknown) => Promise<string>;

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
