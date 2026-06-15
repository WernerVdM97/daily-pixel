// ── ErrorMapper ── pure function, no dependencies
// Maps errors to user-facing Discord messages per S4 spec.

const ERROR_MAP: Array<[string, string]> = [
  // Rolls
  ['No rolls remaining', 'The day is done. `/sleep` to make camp by the Oak — the world turns at nightfall.'],

  // Action state
  ['No action in progress', 'There\'s nothing to continue. Try `/hi` to start your day.'],
  ['No action to resume', 'There\'s nothing to continue. Try `/hi` to start your day.'],

  // Character
  ['Character not found', 'You don\'t have a character. Use `/join` to create one.'],
  ['User already has a character', 'You already have a character.'],

  // Wizard
  ['Wizard session expired', 'Timed out. Try `/join` again.'],
  ['No wizard session found', 'Your character creation session has expired. Try `/join` again.'],
  ['Name must be', 'Invalid character name. Names must be 2–30 characters with no Discord pings.'],

  // Choice / expired
  ['Invalid choice:', 'That option is no longer available. Try again.'],

  // LLM
  ['DeepSeek API error', 'The warden\'s vision is clouded. Try again shortly.'],
  ['DeepSeek returned empty response', 'The warden\'s vision is clouded. Try again shortly.'],
  ['Failed to parse DeepSeek response', 'The warden\'s vision is clouded. Try again shortly.'],

  // DB
  ['Database not initialized', 'Something went wrong. The warden has been notified.'],
  ['Mutation validation failed', 'Something went wrong. The warden has been notified.'],

  // Mock / dev
  ['no canned', 'Internal error: test fixture not configured.'],
];

const FALLBACK_MESSAGE = 'Something went wrong. The warden has been notified.';

/**
 * Map an unknown error to a user-facing message string.
 * Uses substring matching against a prioritized list of known error patterns.
 * Unknown errors get a generic fallback message.
 */
export function mapError(error: unknown): string {
  if (!(error instanceof Error)) {
    return FALLBACK_MESSAGE;
  }

  const message = error.message;

  for (const [pattern, userMessage] of ERROR_MAP) {
    if (message.includes(pattern)) {
      return userMessage;
    }
  }

  return FALLBACK_MESSAGE;
}
