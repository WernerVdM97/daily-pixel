// ── IdleMessageSelector ── pure function, no dependencies
// Random atmospheric messages shown while waiting for LLM (<5s).

const IDLE_MESSAGES: readonly string[] = [
  'The warden tends the fire.',
  'A crow watches from the Oak.',
  'The ember glows faintly.',
  'The wind carries smoke from the east.',
  'The old boards creak beneath your feet.',
];

/**
 * Return a random idle message.
 * Accepts an optional RNG function for deterministic testing (defaults to Math.random).
 */
export function randomIdleMessage(rng: () => number = Math.random): string {
  const index = Math.floor(rng() * IDLE_MESSAGES.length);
  return IDLE_MESSAGES[index];
}
