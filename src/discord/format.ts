/**
 * Discord transport formatting: Components V2 payload assembly and the button rows.
 *
 * Builds Components V2 payloads using the native Separator component ({ type: 14 })
 * rather than text separator lines, plus optional nav buttons. Text is split on the
 * SEPARATOR line into TextDisplay sections (Separators between) inside one Container;
 * nav buttons become Action Rows below.
 *
 * The display vocabulary this used to carry (SEPARATOR, direction helpers, the emoji
 * lookups) moved to `src/render/format.ts` at M10.1 — it was read by the controller,
 * view and render layers, which had no business importing from an adapter. Nothing is
 * re-exported from here: a compat re-export would leave the inverted path resolving and
 * quietly defeat the point (the DC-M9.4.3 rule, applied again).
 *
 * Usage:
 *   const payload = buildComponentPayload(`section 1 text`, { navButtons: getNavButtons(char) });
 *   await interaction.reply(payload);
 */

import { SEPARATOR } from '../render/format.js';

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
  { id: 'look',     label: 'Look',     emoji: '👁️', showOnPages: ['hi', 'journal', 'backpack', 'stats', 'map'] },
  { id: 'stats',    label: 'Stats',    emoji: '📊', showOnPages: ['journal', 'backpack', 'look', 'map'] },
  { id: 'backpack', label: 'Backpack', emoji: '🎒', showOnPages: ['journal', 'stats', 'look', 'map'] },
  { id: 'map',      label: 'Map',      emoji: '🗺️', showOnPages: ['hi', 'journal', 'backpack', 'stats', 'look'] },
];

/** Either the raw character shape (`lastActionState`, `hasPendingAction` derived) or the
 *  protocol's `facts.nav` shape (`hasPendingAction` already computed) — DC-M9.6. */
type NavButtonsChar =
  | { rollsRemaining: number; lastActionState: unknown; hasRestedToday?: boolean }
  | { rollsRemaining: number; hasPendingAction: boolean; hasRestedToday: boolean };

/**
 * Build nav Action Row(s) — up to 2 rows, 5 buttons max each. Omits buttons whose
 * `showIf` returns false and the button matching `currentCommand` (so a view never
 * shows its own nav button).
 */
export function getNavButtons(
  char: NavButtonsChar,
  currentCommand?: string,
): Array<{
  type: number;
  components: Array<{ type: number; custom_id: string; label: string; emoji: { name: string }; style: number }>;
}> {
  const ctx = {
    rollsRemaining: char.rollsRemaining,
    hasPendingAction: 'hasPendingAction' in char ? char.hasPendingAction : char.lastActionState !== null,
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

/**
 * Extract the trailing numeric action id from an outcome custom_id — works for both the button
 * (`outcome:bug:42`) and modal (`outcome:bug:modal:42`) forms, and returns undefined when absent
 * (`outcome:bug`, `outcome:bug:modal`). Inverse of the suffix `getOutcomeServiceButtons` appends.
 */
export function parseOutcomeActionId(customId: string): number | undefined {
  const last = customId.split(':').pop();
  const n = Number(last);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Service buttons for action outcomes: feedback + bug report. When `actionId` is given it's
 * appended to each custom_id (`outcome:feedback:<id>` / `outcome:bug:<id>`) so a report can be
 * attributed to the action whose outcome the button was on. Omitted → bare `outcome:feedback`
 * (off-action surfaces, or older messages the handlers still accept).
 */
export function getOutcomeServiceButtons(actionId?: number): Array<{
  type: number;
  components: Array<{ type: number; custom_id: string; label: string; emoji: { name: string }; style: number }>;
}> {
  const suffix = actionId !== undefined ? `:${actionId}` : '';
  return [{
    type: CT.ACTION_ROW,
    components: [
      { type: CT.BUTTON, custom_id: `outcome:feedback${suffix}`, label: 'Feedback', emoji: { name: '💬' }, style: BS.SECONDARY },
      { type: CT.BUTTON, custom_id: `outcome:bug${suffix}`, label: 'Bug Report', emoji: { name: '🐛' }, style: BS.SECONDARY },
    ],
  }];
}

/**
 * Buttons for the PUBLIC outcome copy posted to the weekly thread: a "Hi" re-entry
 * button (`nav:hi`) ahead of the feedback/bug-report service buttons, so a reader can
 * jump straight into play from the thread. The private reply already carries the full
 * nav bar, so Hi is added here only for the thread copy. The `nav:hi` handler already
 * spawns a fresh per-clicker ephemeral on public messages (see navResponseMode).
 */
export function getPublicOutcomeButtons(actionId?: number): ReturnType<typeof getOutcomeServiceButtons> {
  const [serviceRow] = getOutcomeServiceButtons(actionId);
  return [{
    ...serviceRow,
    components: [
      { type: CT.BUTTON, custom_id: 'nav:hi', label: 'Hi', emoji: { name: '🌅' }, style: BS.SECONDARY },
      ...serviceRow.components,
    ],
  }];
}

/**
 * How a nav-button click should respond, given the source message's flags. Edit in place
 * ONLY when the source is itself a Components-V2 ephemeral: `update()` is a partial edit,
 * so on a legacy embed message (the action outcome) it would preserve the embeds and clash
 * with the V2 flag — and a legacy message can't be toggled into V2 anyway (Discord 50035).
 * Legacy-ephemeral and public messages both spawn a fresh per-clicker ephemeral instead.
 */
export function navResponseMode(source: { ephemeral: boolean; componentsV2: boolean }): 'update' | 'reply' {
  return source.ephemeral && source.componentsV2 ? 'update' : 'reply';
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
