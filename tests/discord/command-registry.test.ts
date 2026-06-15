import { describe, it, expect } from 'vitest';
import { CommandRegistry } from '../../src/discord/CommandRegistry.js';

describe('CommandRegistry', () => {
  it('registers and dispatches a command by name', async () => {
    const registry = new CommandRegistry();
    registry.register('ping', async () => 'pong');

    const handler = registry.get('ping');
    expect(handler).toBeDefined();

    const result = await handler!({} as never);
    expect(result).toBe('pong');
  });

  it('returns undefined for unregistered commands', () => {
    const registry = new CommandRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered command names', () => {
    const registry = new CommandRegistry();
    registry.register('ping', async () => 'pong');
    registry.register('hi', async () => 'hello');
    expect(registry.commandNames()).toEqual(['ping', 'hi']);
  });

  it('throws when registering a duplicate command name', () => {
    const registry = new CommandRegistry();
    registry.register('ping', async () => 'pong');
    expect(() => registry.register('ping', async () => 'pong2'))
      .toThrow(/already registered/);
  });
});
