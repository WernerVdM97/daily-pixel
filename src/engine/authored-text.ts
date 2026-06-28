/**
 * Neutralize LLM/player-authored free text before it's persisted and later re-emitted into
 * BOTH Discord markdown (/map, /look, /journal) and the decision prompt. A crafted place name
 * or teaser like `**The** ## Void` would otherwise break /map layout or inject a fake `###`
 * section into the prompt's "here + exits" block. Strips markdown/section/mention control chars,
 * collapses whitespace (newlines included), and caps length. Keeps letters, digits, and prose
 * punctuation. Not a security boundary — defense-in-depth, since the source is trusted-ish.
 */
export function sanitizeAuthored(text: string, maxLen = 80): string {
  return text
    .replace(/[#*_~`|[\]<>\\]/g, "") // markdown / section / mention / escape control chars
    .replace(/\s+/g, " ") // collapse newlines & whitespace runs into single spaces
    .trim()
    .slice(0, maxLen)
    .trim(); // a boundary slice can re-expose a trailing space
}
