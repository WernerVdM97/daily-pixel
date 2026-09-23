/**
 * Neutralises authored place names, regions and teasers before persistence and re-emission into Discord
 * markdown and the decision prompt, where a crafted name could break the map or fake a section. Defence in depth, not a security boundary.
 */
export function sanitizeAuthored(text: string, maxLen = 80): string {
  return text
    .replace(/[#*_~`|[\]<>\\]/g, "") // markdown / section / mention / escape control chars
    .replace(/\s+/g, " ") // collapse newlines & whitespace runs into single spaces
    .trim()
    .slice(0, maxLen)
    .trim(); // a boundary slice can re-expose a trailing space
}
