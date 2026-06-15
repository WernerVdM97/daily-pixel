import { describe, it, expect } from 'vitest';
import { pingCommand } from '../../src/discord/commands/ping.js';

describe('/ping', () => {
  it('returns "pong"', async () => {
    const result = await pingCommand({} as never);
    expect(result).toBe('pong');
  });
});
