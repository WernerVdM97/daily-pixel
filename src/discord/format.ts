/** Discord transport formatting: Components V2 payload assembly and the button rows.
 *  The display vocabulary moved to `src/render/format.ts` and is deliberately not re-exported here. */

import { SEPARATOR } from '../render/format.js';

const CT = {
  ACTION_ROW: 1,
  BUTTON: 2,
  TEXT_DISPLAY: 10,
  MEDIA_GALLERY: 12,
  SEPARATOR: 14,
  CONTAINER: 17,
} as const;

const BS = {
  SECONDARY: 2,
} as const;

/** Flag required to enable Components V2 on a message. Disables `content` and `embeds`. */
export const IS_COMPONENTS_V2 = 1 << 15; // 32768

/** MessageFlags.Ephemeral. Set via `flags` (the `ephemeral` reply option is deprecated). */
const EPHEMERAL = 1 << 6; // 64

interface NavButtonDef {
  id: string;
  label: string;
  emoji: string;
  /** Returns false to omit the button. Default: always shown. */
  showIf?: (ctx: { rollsRemaining: number; hasPendingAction: boolean; hasRestedToday: boolean }) => boolean;
  /** Restricts the button to these pages; without it the button is global (every page bar the current one). */
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
    // Hidden out of rolls and not mid-action.
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

/** Either the raw character shape (`lastActionState`) or the protocol's `facts.nav` shape. */
type NavButtonsChar =
  | { rollsRemaining: number; lastActionState: unknown; hasRestedToday?: boolean }
  | { rollsRemaining: number; hasPendingAction: boolean; hasRestedToday: boolean };

/**
 * Build nav Action Row(s): up to 2 rows of 5, dropping `showIf`-false buttons and the one matching
 * `currentCommand`, so a view never shows its own nav button.
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

  // 5 is Discord's cap on buttons per Action Row.
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
 * Trailing numeric action id from an outcome custom_id, in both the button (`outcome:bug:42`) and modal
 * (`outcome:bug:modal:42`) forms; undefined when absent. Inverse of the suffix the service buttons append.
 */
export function parseOutcomeActionId(customId: string): number | undefined {
  const last = customId.split(':').pop();
  const n = Number(last);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Feedback + bug-report buttons for an outcome. A given `actionId` is appended to each custom_id so a
 * report can be attributed; omitting it yields the bare ids off-action surfaces and older messages use.
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
 * The weekly-thread copy of an outcome gets a `nav:hi` re-entry button ahead of the service buttons; the
 * private reply already carries the full nav bar. `nav:hi` on a public message opens a fresh ephemeral.
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
 * Edit in place only for a Components-V2 ephemeral: `update()` is a partial edit, so on the legacy embed
 * it would keep the embeds and clash with the V2 flag (50035). Everything else replies per clicker.
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
     * Filename of a banner image (MediaGallery at top of container). The caller MUST also pass the matching
     * attachment in the reply's `files` (see ./images), referenced as `attachment://<image>`.
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
  const sections = text
    .split(new RegExp(`\\n?${escapeRegex(SEPARATOR)}\\n?`))
    .map(s => s.trim())
    .filter(Boolean);

  const contentComponents: Array<{ type: number; content?: string; items?: Array<{ media: { url: string } }> }> = [];

  if (opts?.image) {
    contentComponents.push({
      type: CT.MEDIA_GALLERY,
      items: [{ media: { url: `attachment://${opts.image}` } }],
    });
  }

  if (sections.length === 0) {
    contentComponents.push({ type: CT.TEXT_DISPLAY, content: text });
  } else {
    for (let i = 0; i < sections.length; i++) {
      if (i > 0) contentComponents.push({ type: CT.SEPARATOR });
      contentComponents.push({ type: CT.TEXT_DISPLAY, content: sections[i] });
    }
  }

  const result: {
    flags: number;
    components: Array<unknown>;
  } = {
    // Folded into flags: the `ephemeral` reply option is deprecated and a V2 message can't mix the two.
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
