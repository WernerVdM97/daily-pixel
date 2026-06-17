/**
 * Shared Discord formatting utilities.
 *
 * Provides helpers to build Components V2 message payloads with the native
 * Separator component ({ type: 14 }) instead of text-based separator lines,
 * and optional navigation buttons at the bottom of command responses.
 *
 * Usage:
 *   const payload = buildComponentPayload(`section 1 text`, {
 *     navButtons: getNavButtons(char),
 *   });
 *   await interaction.reply(payload);
 *
 * The text is split by the SEPARATOR line into sections, each rendered as a
 * TextDisplay component with Separators between them inside a single Container.
 * Navigation buttons are appended as one or more Action Rows below the content.
 */

/** Sentinel used in command output to mark section boundaries for splitting. */
export const SEPARATOR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

/** Component type constants for Components V2. */
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

/**
 * Navigation button definitions.
 * Each entry: [customId suffix, label, emoji, showCondition?]
 * showCondition receives { rollsRemaining, hasPendingAction }.
 */
interface NavButtonDef {
  id: string;
  label: string;
  emoji: string;
  /** If false, the button is omitted. Default: always shown. */
  showIf?: (ctx: { rollsRemaining: number; hasPendingAction: boolean }) => boolean;
}

const NAV_BUTTONS: NavButtonDef[] = [
  { id: 'hi',        label: 'Hi',        emoji: '🌅' },
  { id: 'look',      label: 'Look',      emoji: '👁️' },
  { id: 'stats',     label: 'Stats',     emoji: '📊' },
  { id: 'backpack',  label: 'Backpack',  emoji: '🎒' },
  { id: 'journal',   label: 'Journal',   emoji: '📖' },
  {
    id: 'action',
    label: 'Action',
    emoji: '⚔️',
    // Hidden exactly when Sleep takes its place — out of rolls and not mid-action.
    // Otherwise the button just dead-ends on the "out of actions for today" guard.
    showIf: (ctx) => ctx.rollsRemaining > 0 || ctx.hasPendingAction,
  },
  {
    id: 'sleep',
    label: 'Sleep',
    emoji: '😴',
    showIf: (ctx) => ctx.rollsRemaining === 0 && !ctx.hasPendingAction,
  },
];

/**
 * Build Action Row(s) containing navigation buttons.
 *
 * Returns up to 2 rows (5 buttons max per row). Omits buttons whose
 * `showIf` condition returns false, and excludes the current command
 * (so the view you're on doesn't show its own nav button).
 *
 * @param char - Character data for roll/pending-action checks.
 * @param currentCommand - The command currently displayed (e.g. 'hi', 'look').
 *                         Its matching nav button is omitted.
 */
export function getNavButtons(
  char: { rollsRemaining: number; lastActionState: unknown },
  currentCommand?: string,
): Array<{
  type: number;
  components: Array<{ type: number; custom_id: string; label: string; emoji: { name: string }; style: number }>;
}> {
  const ctx = {
    rollsRemaining: char.rollsRemaining,
    hasPendingAction: char.lastActionState !== null,
  };

  const buttons = NAV_BUTTONS
    .filter(b => (!b.showIf || b.showIf(ctx)) && b.id !== currentCommand)
    .map(b => ({
      type: CT.BUTTON,
      custom_id: `nav:${b.id}`,
      label: b.label,
      emoji: { name: b.emoji },
      style: BS.SECONDARY,
    }));

  if (buttons.length === 0) return [];

  // Split into rows of max 5
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

/**
 * Build a Components V2 payload from text, optionally appending nav buttons.
 *
 * @param text  - The raw text response from a command handler.
 * @param opts  - Options including ephemeral flag and navigation row data.
 */
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
     * Filename of an image to show at the top of the container as a MediaGallery.
     * The caller MUST also pass the matching attachment in the reply's `files`
     * (see `imageFiles` / `imageAttachment` in ./images). Referenced as
     * `attachment://<image>`.
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
  // Split the text on SEPARATOR lines into sections.
  const sections = text
    .split(new RegExp(`\\n?${escapeRegex(SEPARATOR)}\\n?`))
    .map(s => s.trim())
    .filter(Boolean);

  const contentComponents: Array<{ type: number; content?: string; items?: Array<{ media: { url: string } }> }> = [];

  // Optional banner image at the top of the container.
  if (opts?.image) {
    contentComponents.push({
      type: CT.MEDIA_GALLERY,
      items: [{ media: { url: `attachment://${opts.image}` } }],
    });
  }

  if (sections.length === 0) {
    // Single section — wrap as one TextDisplay.
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
    // Ephemeral is folded into the flags bitfield (the `ephemeral` reply option
    // is deprecated, and a V2 message can't mix `flags` with a separate `ephemeral`).
    flags: IS_COMPONENTS_V2 | (opts?.ephemeral ? EPHEMERAL : 0),
    components: [{ type: CT.CONTAINER, components: contentComponents }],
  };

  // Append nav button rows after the content container.
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
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
