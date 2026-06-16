/**
 * Profanity filter — applies regex patterns from the `PROFANITY_FILTER`
 * environment variable to custom action text input.
 *
 * Usage: set `PROFANITY_FILTER=\b(frack|darn|hecka)\b,\botherpattern\b` in .env
 * Patterns are comma-separated and each is compiled as a case-insensitive RegExp.
 * When text matches any pattern the action is rejected with a generic message.
 */

let _compiled: RegExp[] | null = null;

function compilePatterns(): RegExp[] {
  const raw = process.env.PROFANITY_FILTER ?? '';
  if (!raw.trim()) return [];

  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pattern) => {
      try {
        return new RegExp(pattern, 'iu'); // case-insensitive, unicode
      } catch {
        console.warn(`[profanity] Skipping invalid regex pattern: "${pattern}"`);
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

/**
 * Returns the first matching pattern if `text` contains blocked content,
 * or `null` if the text is clean.
 */
export function checkProfanity(text: string): string | null {
  if (!_compiled) _compiled = compilePatterns();
  if (_compiled.length === 0) return null;

  for (const re of _compiled) {
    const match = text.match(re);
    if (match) return match[0];
  }

  return null;
}

/**
 * Cold-reload the compiled patterns. Useful for tests that mutate env vars.
 */
export function resetCache(): void {
  _compiled = null;
}
