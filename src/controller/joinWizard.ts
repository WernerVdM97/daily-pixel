/**
 * The character-creation wizard composition (M7.3, DC-M7.3.4) — the join walk's defs,
 * option-building, and screen assembly lifted from the pre-seam src/discord/commands/join.ts
 * into the controller layer (the hiScreen.ts pattern). Composition lives here, not the
 * router: the router's Home rule (DC-P8) forbids src/discord/ imports, and the M3–M6
 * pattern composes views in the backend's view layer. `CharDefs`/`NamedDef`/`ItemSetDef`/
 * `buildStepOptions` moved here verbatim (join.ts stops exporting them); `composeWizardView`
 * is a faithful lift of the old `buildStepMessage`'s content assembly (ledger lines incl.
 * the `chosenEmoji` rule and the `~~heading~~ → **value**` struck-through line, the
 * option-block body with stat-bonus blockquotes, the name prompt, the ready prose, the
 * footers, the step-7 class-filtered kits); `isValidWizardChoice` serves the router's
 * illegal-move arm.
 */

import type { WizardState } from '../discord/WizardSession.js';
import { STAT_LABELS } from '../engine/stat-format.js';
import type { WizardViewState } from '../view/viewState.js';

/** A YAML char-creation entry — only the fields the wizard renders. */
export interface NamedDef {
  name: string;
  description?: string;
  emoji: string;
  /** Per-stat bonuses (classes/backgrounds/races); absent on entries that grant none. */
  modifiers?: Record<string, number>;
}
/** A starting-kit entry from item-sets.yml. */
export interface ItemSetDef {
  name: string;
  description: string;
  for_classes: string[];
  /** Items the kit grants, each carrying the stat + d20 modifier it boosts. */
  items?: Array<{ stat: string; modifier: number; quantity?: number }>;
}
/** All char-creation option data from assets/char-creation/*.yml. */
export interface CharDefs {
  classes: NamedDef[];
  backgrounds: NamedDef[];
  races: NamedDef[];
  alignments: NamedDef[];
  dayJobs: NamedDef[];
  itemSets: ItemSetDef[];
}

interface OptionDef {
  /** Button label and bold body name. */
  label: string;
  /** Value persisted to the character. */
  value: string;
  emoji: string;
  /** One-line flavour in the embed body (YAML `description`). */
  description: string;
  /** Pre-rendered stat-bonus run, e.g. `💪+3 🧠-1` — "" when the option grants none. */
  statBonuses: string;
}

const FALLBACK_EMOJI = '🔹';

/** Render nonzero per-stat bonuses as emoji + signed amount, in canonical stat order. */
export function formatStatBonuses(mods: Record<string, number> | undefined): string {
  if (!mods) return '';
  return Object.keys(STAT_LABELS)
    .filter(stat => (mods[stat] ?? 0) !== 0)
    .map(stat => {
      const v = mods[stat];
      return `${STAT_LABELS[stat].emoji}${v > 0 ? `+${v}` : `${v}`}`;
    })
    .join(' ');
}

/** Sum a kit's per-item modifiers into a per-stat total. */
export function sumItemModifiers(items: ItemSetDef['items']): Record<string, number> {
  const mods: Record<string, number> = {};
  for (const it of items ?? []) mods[it.stat] = (mods[it.stat] ?? 0) + it.modifier;
  return mods;
}

/** Options for a step, built from the YAML defs (emoji read straight off each entry). */
export function buildStepOptions(step: number, defs: CharDefs, chosenClass?: string): OptionDef[] {
  const toOption = (d: NamedDef, value?: string): OptionDef => ({
    label: d.name,
    value: value ?? d.name,
    emoji: d.emoji || FALLBACK_EMOJI,
    description: d.description ?? '',
    statBonuses: formatStatBonuses(d.modifiers),
  });

  switch (step) {
    case 2: return defs.classes.map(d => toOption(d));
    case 3: return defs.backgrounds.map(d => toOption(d));
    case 4: return defs.races.map(d => toOption(d));
    // Alignment value stays lowercase ("lawful good") — the format stored & sent to the LLM.
    case 5: return defs.alignments.map(d => toOption(d, d.name.toLowerCase()));
    case 6: return defs.dayJobs.map(d => toOption(d));
    case 7: return defs.itemSets
      .filter(kit => kit.for_classes.includes(chosenClass ?? ''))
      .map(kit => ({
        label: kit.name, value: kit.name, emoji: '🎒', description: kit.description,
        statBonuses: formatStatBonuses(sumItemModifiers(kit.items)),
      }));
    default: return [];
  }
}

/** The router's illegal-move arm (DC-M7.3.6) — is `value` a real option for `step`? The
 *  step-5 (alignment) persisted keys are lowercase, so this checks the persisted values. */
export function isValidWizardChoice(step: number, value: string, defs: CharDefs, chosenClass?: string): boolean {
  return buildStepOptions(step, defs, chosenClass).some(o => o.value === value);
}

/** Title-case "lawful good" → "Lawful Good"; passthrough for undefined. */
export function titleCase(s: string | undefined): string | undefined {
  return s ? s.replace(/\b\w/g, c => c.toUpperCase()) : s;
}

// Per-step metadata: progress-ledger icon + section heading. Single source for both
// the ledger lines and the option-block heading (steps 2-7; step 1 is the name modal).
const STEPS: Record<number, { icon: string; heading: string }> = {
  1: { icon: '📝', heading: 'Name' },
  2: { icon: '🛡️', heading: 'Class' },
  3: { icon: '🌱', heading: 'Upbringing' },
  4: { icon: '🧬', heading: 'Race' },
  5: { icon: '⚖️', heading: 'Alignment' },
  6: { icon: '🔧', heading: 'Day Job' },
  7: { icon: '🎒', heading: 'Starting Kit' },
};

/** The walk has 7 option steps; step 8 is the review screen. */
const TOTAL_STEPS = 7;

/** The step-1 name modal's field spec — the wizard's step-1 free-text answer event maps
 *  onto this (the Discord modal doesn't map onto request/response, M6→M7 steer). */
const NAME_FIELD = {
  label: 'Character Name',
  placeholder: 'Enter a name (2-30 characters)',
  minLength: 2,
  maxLength: 30,
};

/** Compose the semantic wizard view from a wizard draft (DC-M7.3.3/4) — a faithful lift of
 *  the pre-seam `buildStepMessage`'s content assembly: the ledger (per-step line with the
 *  ◀ marker and the struck-through chosen value carrying the option's own emoji), the body
 *  block (name prompt / option list with stat-bonus blockquotes / ready prose), the footers,
 *  and the semantic buttons. The embed chrome (title, goldenrod, Oak thumbnail, files) and
 *  the button customIds/styles/chunking stay in the medium step (`wizardViewToDiscord`). */
export function composeWizardView(state: WizardState, defs: CharDefs): WizardViewState {
  // Chosen values for the ledger: alignment displays title-cased (the persisted value is
  // lowercase); the others verbatim.
  const chosen: Record<number, string | undefined> = {
    1: state.name, 2: state.class, 3: state.upbringing, 4: state.race,
    5: titleCase(state.alignment), 6: state.dayJob, 7: state.itemSet,
  };
  // Raw (pre-titleCase) persisted values — these are what each option's `value` matches,
  // so they're the lookup key for the chosen option's own emoji.
  const rawChosen: Record<number, string | undefined> = {
    2: state.class, 3: state.upbringing, 4: state.race,
    5: state.alignment, 6: state.dayJob, 7: state.itemSet,
  };
  // Graceful miss: a custom/renamed value with no matching def yields "" — never "undefined".
  // Skipped when the option's emoji just repeats the step icon (item kits all share 🎒),
  // which would render the same glyph twice on one ledger line.
  const chosenEmoji = (n: number): string => {
    const raw = rawChosen[n];
    if (!raw) return '';
    const match = buildStepOptions(n, defs, state.class).find(o => o.value === raw);
    return match && match.emoji !== STEPS[n].icon ? `${match.emoji} ` : '';
  };
  const stepLine = (n: number) => {
    const { icon, heading } = STEPS[n];
    const value = chosen[n];
    if (state.step === n) return `${icon} **${heading}** ◀`;
    if (value) return `${icon} ~~${heading}~~ → ${chosenEmoji(n)}**${value}**`;
    return `${icon} ${heading}`;
  };

  const ledger = [1, 2, 3, 4, 5, 6, 7].map(stepLine).join('\n');

  const buttons: WizardViewState['buttons'] = [];
  let body = '';
  let footer = '';

  if (state.step === 1) {
    body = '__**Name**__\nWhat shall the songs call you?';
    footer = `Step 1 of ${TOTAL_STEPS} — 2-30 characters, no @ or #`;
    buttons.push({ kind: 'name', label: 'Enter Name', emoji: '📝' });
  }

  if (state.step >= 2 && state.step <= 7) {
    const opts = buildStepOptions(state.step, defs, state.class);
    const heading = STEPS[state.step]?.heading ?? '';

    // Options block: emoji + bold name on their own line, stat bonuses (if any) set off
    // as a blockquote, description on its own line — crowds less than one long dashed line.
    const list = opts
      .map(o => {
        const lines = [`${o.emoji} **${o.label}**`];
        if (o.statBonuses) lines.push(`> ${o.statBonuses}`);
        if (o.description) lines.push(o.description);
        return lines.join('\n');
      })
      .join('\n\n');
    body = `__**${heading}**__\n${list}`;
    footer = `Step ${state.step} of ${TOTAL_STEPS} — ${heading}`;

    for (const opt of opts) {
      buttons.push({ kind: 'choice', step: state.step, value: opt.value, label: opt.label, emoji: opt.emoji });
    }
    buttons.push({ kind: 'restart', label: 'Start Over', emoji: '🔄' });
  }

  if (state.step === 8) {
    body = '__**Ready**__\nYour hero stands ready. Confirm to step into the world — or start over.';
    footer = 'Review your choices and confirm';
    buttons.push({ kind: 'confirm', label: 'Confirm', emoji: '✅' });
    buttons.push({ kind: 'restart', label: 'Start Over', emoji: '🔄' });
  }

  return {
    screen: 'wizard',
    step: state.step,
    totalSteps: TOTAL_STEPS,
    ledger,
    body,
    footer,
    ...(state.step === 1 ? { nameField: { ...NAME_FIELD } } : {}),
    ...(state.step >= 2 && state.step <= 7 ? { options: buildStepOptions(state.step, defs, state.class).map(o => ({ value: o.value, label: o.label, emoji: o.emoji })) } : {}),
    buttons,
  };
}
