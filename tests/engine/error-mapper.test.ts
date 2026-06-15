// RED: tests fail because ErrorMapper doesn't exist yet

import { describe, it, expect } from 'vitest';
import { mapError } from '../../src/engine/ErrorMapper.js';

describe('ErrorMapper — known errors', () => {
  it('maps "No rolls remaining" to the sleep hint', () => {
    const result = mapError(new Error('No rolls remaining'));
    expect(result).toBe(
      'The day is done. `/sleep` to make camp by the Oak — the world turns at nightfall.',
    );
  });

  it('maps "No action in progress" to continue hint', () => {
    const result = mapError(new Error('No action in progress'));
    expect(result).toBe("There's nothing to continue. Try `/hi` to start your day.");
  });

  it('maps "No action to resume" to continue hint', () => {
    const result = mapError(new Error('No action to resume'));
    expect(result).toBe("There's nothing to continue. Try `/hi` to start your day.");
  });

  it('maps "Character not found" to no-character message', () => {
    const result = mapError(new Error('Character not found'));
    expect(result).toBe('You don\'t have a character. Use `/join` to create one.');
  });

  it('maps already-has-character errors', () => {
    const result = mapError(new Error('User already has a character'));
    expect(result).toBe('You already have a character.');
  });

  it('maps wizard timeout errors', () => {
    const result = mapError(new Error('Wizard session expired'));
    expect(result).toBe('Timed out. Try `/join` again.');
  });

  it('maps invalid choice errors', () => {
    const result = mapError(new Error('Invalid choice: "Bogus"'));
    expect(result).toBe('That option is no longer available. Try again.');
  });

  it('maps action timeout errors', () => {
    const result = mapError(new Error('Action timed out after 30 minutes'));
    expect(result).toBe('Your action has expired. The moment has passed. Try `/hi` to start fresh.');
  });

  it('maps DeepSeek API errors', () => {
    const result = mapError(new Error('DeepSeek API error 401: Unauthorized'));
    expect(result).toBe('The warden\'s vision is clouded. Try again shortly.');
  });

  it('maps generic DB connection errors', () => {
    const result = mapError(new Error('Database not initialized'));
    expect(result).toBe('Something went wrong. The warden has been notified.');
  });
});

describe('ErrorMapper — unknown / fallback', () => {
  it('maps unknown errors to generic message', () => {
    const result = mapError(new Error('Something completely unexpected'));
    expect(result).toBe('Something went wrong. The warden has been notified.');
  });

  it('maps non-Error values to generic message', () => {
    const result = mapError('just a string');
    expect(result).toBe('Something went wrong. The warden has been notified.');
  });

  it('maps null values to generic message', () => {
    const result = mapError(null);
    expect(result).toBe('Something went wrong. The warden has been notified.');
  });

  it('maps undefined to generic message', () => {
    const result = mapError(undefined);
    expect(result).toBe('Something went wrong. The warden has been notified.');
  });

  it('maps object errors to generic message', () => {
    const result = mapError({ code: 500 });
    expect(result).toBe('Something went wrong. The warden has been notified.');
  });
});
