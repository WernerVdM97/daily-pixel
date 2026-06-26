/**
 * Shared Discord formatting utilities.
 *
 * Builds Components V2 payloads using the native Separator component ({ type: 14 })
 * rather than text separator lines, plus optional nav buttons. Text is split on the
 * SEPARATOR line into TextDisplay sections (Separators between) inside one Container;
 * nav buttons become Action Rows below.
 *
 * Usage:
 *   const payload = buildComponentPayload(`section 1 text`, { navButtons: getNavButtons(char) });
 *   await interaction.reply(payload);
 */

/** Sentinel used in command output to mark section boundaries for splitting. */
export const SEPARATOR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

/** Fallback emoji for an unknown class. */
export const CLASS_EMOJI_FALLBACK = '🔹';

/** Player-class → emoji. Shared by char creation (join) and outcome broadcasts. */
export const CLASS_EMOJI: Record<string, string> = {
  Warrior: '⚔️',
  Ranger: '🏹',
  Wizard: '🔮',
  Bard: '🎵',
  Priest: '✝️',
};

/** Emoji for a player class, falling back to a neutral marker for unknown classes. */
export function classEmoji(charClass: string | null | undefined): string {
  return (charClass && CLASS_EMOJI[charClass]) || CLASS_EMOJI_FALLBACK;
}

/** Components V2 type constants. */
const CT = {
  ACTION_ROW: 1,
  BUTTON: 2,
  TEXT_DISPLAY: 10,
  MEDIA_GALLERY: 12,
  SEPARATOR: 14,
  CONTAINER: 17,
} as const;

/** Button style constants. */
const BS = {
  SECONDARY: 2,
} as const;

/** Flag required to enable Components V2 on a message. Disables `content` and `embeds`. */
export const IS_COMPONENTS_V2 = 1 << 15; // 32768

/** MessageFlags.Ephemeral. Set via `flags` (the `ephemeral` reply option is deprecated). */
const EPHEMERAL = 1 << 6; // 64

/** Navigation button definition. */
interface NavButtonDef {
  id: string;
  label: string;
  emoji: string;
  /** Returns false to omit the button. Default: always shown. */
  showIf?: (ctx: { rollsRemaining: number; hasPendingAction: boolean; hasRestedToday: boolean }) => boolean;
  /**
   * Restricts the button to these pages — used by the "view" buttons (look/stats/backpack)
   * to cross-link among info pages instead of cluttering every screen. Buttons without
   * `showOnPages` are global (every page minus the current one).
   */
  showOnPages?: string[];
}

const NAV_BUTTONS: NavButtonDef[] = [
  // Global flow buttons — every page minus the current one.
  { id: 'hi',        label: 'Hi',        emoji: '🌅' },
  { id: 'journal',   label: 'Journal',   emoji: '📖' },
  {
    id: 'action',
    label: 'Action',
    emoji: '⚔️',
    // Hidden exactly when Rest takes its place — out of rolls and not mid-action.
    showIf: (ctx) => ctx.rollsRemaining > 0 || ctx.hasPendingAction,
  },
  {
    // id stays 'sleep' to route to /sleep; only label/emoji read as "Rest".
    id: 'sleep',
    label: 'Rest',
    emoji: '🏕️',
    // Shown once actions are spent and idle — but hidden after resting until the next tick.
    showIf: (ctx) => ctx.rollsRemaining === 0 && !ctx.hasPendingAction && !ctx.hasRestedToday,
  },
  // View buttons — info pages cross-link to each other; Look also appears on Hi.
  // They stay off action/sleep/outcome views.
  { id: 'look',     label: 'Look',     emoji: '👁️', showOnPages: ['hi', 'journal', 'backpack', 'stats'] },
  { id: 'stats',    label: 'Stats',    emoji: '📊', showOnPages: ['journal', 'backpack', 'look'] },
  { id: 'backpack', label: 'Backpack', emoji: '🎒', showOnPages: ['journal', 'stats', 'look'] },
];

/**
 * Build nav Action Row(s) — up to 2 rows, 5 buttons max each. Omits buttons whose
 * `showIf` returns false and the button matching `currentCommand` (so a view never
 * shows its own nav button).
 */
export function getNavButtons(
  char: { rollsRemaining: number; lastActionState: unknown; hasRestedToday?: boolean },
  currentCommand?: string,
): Array<{
  type: number;
  components: Array<{ type: number; custom_id: string; label: string; emoji: { name: string }; style: number }>;
}> {
  const ctx = {
    rollsRemaining: char.rollsRemaining,
    hasPendingAction: char.lastActionState !== null,
    hasRestedToday: char.hasRestedToday ?? false,
  };

  const buttons = NAV_BUTTONS
    .filter(b =>
      (!b.showIf || b.showIf(ctx)) &&
      b.id !== currentCommand &&
      // Page-scoped buttons only on their listed pages — never when there's no
      // current page (e.g. public action-outcome broadcasts).
      (!b.showOnPages || (currentCommand !== undefined && b.showOnPages.includes(currentCommand))),
    )
    .map(b => ({
      type: CT.BUTTON,
      custom_id: `nav:${b.id}`,
      label: b.label,
      emoji: { name: b.emoji },
      style: BS.SECONDARY,
    }));

  if (buttons.length === 0) return [];

  // Split into rows of max 5.
  const rows: Array<{
    type: number;
    components: Array<{ type: number; custom_id: string; label: string; emoji: { name: string }; style: number }>;
  }> = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({
      type: CT.ACTION_ROW,
      components: buttons.slice(i, i + 5),
    });
  }
  return rows;
}

/** Service buttons for action outcomes: feedback + bug report. */
export function getOutcomeServiceButtons(): Array<{
  type: number;
  components: Array<{ type: number; custom_id: string; label: string; emoji: { name: string }; style: number }>;
}> {
  return [{
    type: CT.ACTION_ROW,
    components: [
      { type: CT.BUTTON, custom_id: 'outcome:feedback', label: 'Feedback', emoji: { name: '💬' }, style: BS.SECONDARY },
      { type: CT.BUTTON, custom_id: 'outcome:bug', label: 'Bug Report', emoji: { name: '🐛' }, style: BS.SECONDARY },
    ],
  }];
}

/** Build a Components V2 payload from text, optionally appending nav buttons. */
export function buildComponentPayload(
  text: string,
  opts?: {
    ephemeral?: boolean;
    /** Navigation buttons to append. Use `getNavButtons(char)` to build these. */
    navButtons?: Array<{
      type: number;
      components: Array<{ type: number; custom_id: string; label: string; emoji: { name: string }; style: number }>;
    }>;
    /**
     * Filename of a banner image (MediaGallery at top of container). Caller MUST also
     * pass the matching attachment in the reply's `files` (see ./images); referenced
     * as `attachment://<image>`.
     */
    image?: string;
  },
): {
  flags: number;
  components: Array<
    | { type: number; components: Array<{ type: number; content?: string }> }
    | { type: number; components: Array<{ type: number; custom_id: string; label: string; emoji: { name: string }; style: number }> }
  >;
} {
  // Split on SEPARATOR lines into sections.
  const sections = text
    .split(new RegExp(`\\n?${escapeRegex(SEPARATOR)}\\n?`))
    .map(s => s.trim())
    .filter(Boolean);

  const contentComponents: Array<{ type: number; content?: string; items?: Array<{ media: { url: string } }> }> = [];

  // Optional banner image at top of container.
  if (opts?.image) {
    contentComponents.push({
      type: CT.MEDIA_GALLERY,
      items: [{ media: { url: `attachment://${opts.image}` } }],
    });
  }

  if (sections.length === 0) {
    contentComponents.push({ type: CT.TEXT_DISPLAY, content: text });
  } else {
    // Interleave TextDisplay and Separator components.
    for (let i = 0; i < sections.length; i++) {
      if (i > 0) contentComponents.push({ type: CT.SEPARATOR });
      contentComponents.push({ type: CT.TEXT_DISPLAY, content: sections[i] });
    }
  }

  const result: {
    flags: number;
    components: Array<unknown>;
  } = {
    // Ephemeral folded into flags — the `ephemeral` reply option is deprecated and a
    // V2 message can't mix `flags` with a separate `ephemeral`.
    flags: IS_COMPONENTS_V2 | (opts?.ephemeral ? EPHEMERAL : 0),
    components: [{ type: CT.CONTAINER, components: contentComponents }],
  };

  if (opts?.navButtons && opts.navButtons.length > 0) {
    result.components.push(...opts.navButtons);
  }

  return result as typeof result & {
    components: Array<
      | { type: number; components: Array<{ type: number; content?: string }> }
      | { type: number; components: Array<{ type: number; custom_id: string; label: string; emoji: { name: string }; style: number }> }
    >;
  };
}

/** Escape special regex chars in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
