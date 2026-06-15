// Minimal ANSI colour helpers for terminal logs.
// Usage: console.log(c.blue('[llm:request]'), ...)

const ansi = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;

export const c = {
  red:     ansi(31),
  green:   ansi(32),
  yellow:  ansi(33),
  blue:    ansi(34),
  magenta: ansi(35),
  cyan:    ansi(36),
  grey:    ansi(90),
} as const;
