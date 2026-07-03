import type { SimResult, TurnTrace } from './types.js';

export interface SimSummary {
  turnsRun: number;
  rollsResolved: number;
  rollSuccessRate: number;
  netHealth: number;
  netStamina: number;
  netWealth: number;
  itemsGained: number;
  avgFinalDc: number;
  /** N/A until the death track lands (TODO.md: "make wealth/stamina/health spendable,
   *  define death / 0 HP"). A `SimSummary.death` field kept as an explicit hook rather
   *  than inventing a mechanic ahead of the design. */
  death: null;
}

/**
 * Turn-per-turn scalars → a scenario-level summary.
 *
 * `net*` figures compare the last turn's post-resolution state to the first turn's —
 * `TurnTrace` only carries POST-resolution snapshots (no pre-run baseline), so the very
 * first turn's own delta from the character's seed isn't captured. Immaterial for the
 * many-turn (week-spanning) curves this harness exists to produce.
 */
export function summarize(r: SimResult): SimSummary {
  const turns = r.turns;
  const turnsRun = turns.length;

  const rolled = turns.filter((t) => t.playerRolled !== null);
  const rollsResolved = rolled.length;
  const successes = rolled.filter((t) => t.outcome === 'success').length;
  const rollSuccessRate = rollsResolved > 0 ? successes / rollsResolved : 0;

  const first = turns[0];
  const last = turns[turnsRun - 1];
  const netHealth = turnsRun > 0 ? last.health - first.health : 0;
  const netStamina = turnsRun > 0 ? last.stamina - first.stamina : 0;
  const netWealth = turnsRun > 0 ? last.wealth - first.wealth : 0;
  const itemsGained = turnsRun > 0 ? last.itemCount - first.itemCount : 0;

  const avgFinalDc =
    turnsRun > 0 ? turns.reduce((sum, t) => sum + (t.finalDc ?? 0), 0) / turnsRun : 0;

  return {
    turnsRun,
    rollsResolved,
    rollSuccessRate,
    netHealth,
    netStamina,
    netWealth,
    itemsGained,
    avgFinalDc,
    death: null,
  };
}

/** Every TurnTrace scalar column, in emission order. `day` is optional pre-T3 wiring —
 *  emitted as an empty cell until a time-advancing scenario sets it. */
const CSV_COLUMNS: (keyof TurnTrace)[] = [
  'index',
  'input',
  'distilledType',
  'finalDc',
  'playerRolled',
  'rollBonus',
  'outcome',
  'health',
  'stamina',
  'wealth',
  'rollsRemaining',
  'itemCount',
  'mutationsApplied',
  'day',
];

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  // RFC 4180: quote (and escape embedded quotes) only when the field needs it.
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Header + one row per turn — every TurnTrace scalar column, so the file is a complete
 *  record for offline plotting/spreadsheet analysis (no charting dependency in-repo). */
export function toCsv(r: SimResult): string {
  const header = CSV_COLUMNS.join(',');
  const rows = r.turns.map((t) => CSV_COLUMNS.map((col) => csvEscape(t[col])).join(','));
  return [header, ...rows].join('\n');
}

function formatSigned(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/** Console summary table rendered after a sim run. */
export function renderTable(s: SimSummary): string {
  const pct = (s.rollSuccessRate * 100).toFixed(1);
  return [
    'Sim Summary',
    '───────────',
    `Turns run:      ${s.turnsRun}`,
    `Rolls resolved: ${s.rollsResolved}`,
    `Roll success:   ${pct}%`,
    `Net health:     ${formatSigned(s.netHealth)}`,
    `Net stamina:    ${formatSigned(s.netStamina)}`,
    `Net wealth:     ${formatSigned(s.netWealth)}`,
    `Items gained:   ${s.itemsGained}`,
    `Avg final DC:   ${s.avgFinalDc.toFixed(1)}`,
    `Death rate:     N/A (death track not yet implemented)`,
  ].join('\n');
}
