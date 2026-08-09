/** Title-case "lawful good" → "Lawful Good"; passthrough for undefined. */
export function titleCase(s: string | undefined): string | undefined {
  return s ? s.replace(/\b\w/g, c => c.toUpperCase()) : s;
}
