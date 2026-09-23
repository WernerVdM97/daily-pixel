// ── IdleMessageSelector ── pure function, no dependencies
// Random atmospheric messages shown while the LLM call is in flight.

const IDLE_MESSAGES: readonly string[] = [
  'The warden tends the fire.',
  'A crow watches from the Oak.',
  'The ember glows faintly.',
  'The wind carries smoke from the east.',
  'The old boards creak beneath your feet.',
];

/**
 * RNG injectable for deterministic tests (defaults to Math.random).
 */
export function randomIdleMessage(rng: () => number = Math.random): string {
  const index = Math.floor(rng() * IDLE_MESSAGES.length);
  return IDLE_MESSAGES[index];
}
