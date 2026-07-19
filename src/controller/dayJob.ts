// ── Day job types (day-jobs.yml shape) ──

export interface DayJobDef {
  name: string;
  depends_on: string[];
  base_income: number;
  /** Teleport target when starting daily work from The Warden's Oak.
   *  Null for Wanderer (seeded random safe location). */
  workplace_location: string | null;
  description: string;
  /** Action pool; `getDayJobActions` surfaces 3 at random (this pool + COMMON_ACTIONS). */
  actions: DayJobAction[];
}

export interface DayJobAction {
  label: string;
  income: number;
  hook: string;
}

/**
 * Cross-job actions mixed into every day-job's pool so the 3 surfaced each day
 * vary instead of reading as a fixed rota.
 */
export const COMMON_ACTIONS: DayJobAction[] = [
  {
    label: "Help at the market",
    income: 3,
    hook: "A stall-keeper could use an extra pair of hands through the morning rush.",
  },
  {
    label: "Lend a neighbour a hand",
    income: 2,
    hook: "Someone nearby is wrestling with a task too big for one person.",
  },
  {
    label: "Run an errand",
    income: 3,
    hook: "A message needs carrying across town before midday.",
  },
  {
    label: "Wait tables at the inn",
    income: 1,
    hook: "The common room is loud and short-handed; clear the plates and keep the ale flowing for a cut of the night's take.",
  },
  {
    label: "See to chores",
    income: 2,
    hook: "There is always work to be done: wood to split, water to haul, a fence to mend.",
  },
  {
    label: "Muck out the stables",
    income: 2,
    hook: "The innkeeper pays to have the stalls cleared and fresh straw laid before the next riders come through.",
  },
  {
    label: "Haul and load",
    income: 3,
    hook: "Crates and sacks need moving before the carts leave. Honest sweat for honest coin.",
  },
  {
    label: "Mind a child",
    income: 2,
    hook: "A harried parent presses a coin into your hand and a restless toddler into your care.",
  },
];

/** Deterministic PRNG (mulberry32) so a given seed always yields the same picks. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Surface 3 daily-work actions sampled from the job's pool + COMMON_ACTIONS.
 * Seeded by (characterId, dayNumber) so /hi, the /action buttons, and the click
 * handler agree within a day and refresh each game day. No opts → seed 0 (for tests).
 */
export function getDayJobActions(
  dayJobName: string,
  dayJobs: DayJobDef[],
  opts: { characterId?: number; dayNumber?: number } = {},
): DayJobAction[] {
  const job = dayJobs.find((j) => j.name === dayJobName);
  if (!job) {
    throw new Error(`Unknown day job "${dayJobName}"`);
  }

  const pool = [...job.actions, ...COMMON_ACTIONS];
  const seed = (opts.characterId ?? 0) * 1000 + (opts.dayNumber ?? 0);
  const rng = mulberry32(seed);

  // Sample up to 3 distinct actions (Fisher-Yates partial draw).
  const remaining = [...pool];
  const picked: DayJobAction[] = [];
  while (picked.length < 3 && remaining.length > 0) {
    const idx = Math.floor(rng() * remaining.length);
    picked.push(remaining.splice(idx, 1)[0]);
  }
  return picked;
}

/** Safe locations a Wanderer can teleport to (excluding The Warden's Oak). */
export const WANDERER_SPOTS: string[] = [
  "Town Square",
  "The Shrine of the First Flame",
  "The Weary Lantern Inn",
  "The Town Forge",
  "The Warden's Library",
];

/**
 * Resolve a day job's workplace location.
 * Wanderer has no fixed workplace in the YAML: pick a seeded safe location using
 * the same mulberry32 PRNG as `getDayJobActions`, so `/hi` and the action agree
 * within a day. Returns `null` only when the job is unknown.
 */
export function getWorkplaceLocation(
  jobName: string,
  dayJobs: DayJobDef[],
  opts: { characterId: number; dayNumber: number },
): string | null {
  const job = dayJobs.find((j) => j.name === jobName);
  if (!job) return null;

  if (job.workplace_location) {
    return job.workplace_location;
  }

  // Wanderer: seeded safe location
  const seed = opts.characterId * 1000 + opts.dayNumber;
  const rng = mulberry32(seed);
  const idx = Math.floor(rng() * WANDERER_SPOTS.length);
  return WANDERER_SPOTS[idx];
}

// ── /action hints ──

export interface ActionHintContext {
  rollsRemaining: number;
  stamina: number;
  maxStamina: number;
  isSafe: boolean;
}

// "Running on fumes" at 25% of max stamina, floored at 2 so low-max characters
// still get the warning at very low absolute stamina rather than never triggering.
const LOW_STAMINA_RATIO = 0.25;
const LOW_STAMINA_FLOOR = 2;

/** Contextual hints for the bare `/action` day-job menu — shared by the slash
 *  path (action.ts) and the `nav:action` button path (index.ts) so they can't drift. */
export function buildActionHints({ rollsRemaining, stamina, maxStamina, isSafe }: ActionHintContext): string[] {
  const hints: string[] = [];

  // Keys off rolls *remaining*, not the day's allowance, so it fires on the genuine last roll
  // whatever that allowance is: exactly one left is always the last action, whether the day
  // grants 3 or Saturday's bonus 4 (N3 — no premature warning a roll early on Saturday).
  if (rollsRemaining === 1) {
    hints.push('🎲 Last action of the day — make it count.');
  }

  const lowStaminaThreshold = Math.max(LOW_STAMINA_FLOOR, Math.round(maxStamina * LOW_STAMINA_RATIO));
  // stamina < maxStamina guards a character at full stamina (e.g. 1/1 or 2/2) from seeing
  // the warning purely because their max is tiny — "fumes" implies having spent some.
  if (stamina <= lowStaminaThreshold && stamina < maxStamina) {
    hints.push(`😮‍💨 You're running on fumes (${stamina}/${maxStamina} stamina).`);
  }

  if (!isSafe) {
    hints.push("⚠️ This place isn't safe — trouble may find you.");
  }

  return hints;
}

// ── Custom IDs ──

export const CID_DAYJOB = 'action:dayjob:';
export const CID_DAYJOB_CUSTOM = 'action:dayjob:custom';
