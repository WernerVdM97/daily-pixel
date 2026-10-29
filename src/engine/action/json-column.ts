/** Tolerant read of a JSON column the engine itself writes: a corrupt or truncated value returns
 *  null and logs, reading as "no state" rather than throwing into an action path. */
export function parseJsonColumn<T>(column: string, raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`[engine] unreadable JSON in ${column} — treating as no state`);
    return null;
  }
}
