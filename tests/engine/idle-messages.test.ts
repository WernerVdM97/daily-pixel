// RED: tests fail because IdleMessageSelector doesn't exist yet

import { describe, it, expect } from 'vitest';
import { randomIdleMessage } from '../../src/engine/IdleMessageSelector.js';

describe('IdleMessageSelector', () => {
  it('returns one of the known idle messages', () => {
    const messages = new Set<string>();
    for (let i = 0; i < 100; i++) {
      messages.add(randomIdleMessage());
    }

    // All returned messages should be from the known set
    const known = [
      'The warden tends the fire.',
      'A crow watches from the Oak.',
      'The ember glows faintly.',
      'The wind carries smoke from the east.',
      'The old boards creak beneath your feet.',
    ];

    for (const msg of messages) {
      expect(known).toContain(msg);
    }

    // After 100 random picks we should have seen all 5
    expect(messages.size).toBe(5);
  });

  it('returns deterministic results with a seeded RNG', () => {
    // Two calls with same seed should return same result
    const rng1 = () => 0.0;
    const rng2 = () => 0.0;
    expect(randomIdleMessage(rng1)).toBe(randomIdleMessage(rng2));

    // Different seed returns different message
    const rng3 = () => 0.999;
    const msg3 = randomIdleMessage(rng3);
    const msg4 = randomIdleMessage(rng1);
    // 0.999 should give last item, 0.0 gives first — they differ
    expect(msg3).not.toBe(msg4);
  });

  it('always returns a string', () => {
    for (let i = 0; i < 20; i++) {
      expect(typeof randomIdleMessage()).toBe('string');
      expect(randomIdleMessage().length).toBeGreaterThan(0);
    }
  });
});
