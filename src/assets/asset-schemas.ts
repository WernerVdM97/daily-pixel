/**
 * Runtime schemas for the shipped YAML assets — the guardrail described in
 * `docs/sparks/yaml-asset-schemas-and-tests.md`. `loadYamlFile` only checks
 * syntax + array-shape, then callers cast with `as`; nothing asserts an entry
 * actually carries the fields its consumer reads. A single omitted stat key in
 * `backgrounds.yml` once flowed unchecked through `computeStats` → NaN →
 * `null` ability scores on live characters. These hand-rolled validators (no
 * new deps) are the single source of truth used by both the boot-time loader
 * (`loadAndValidate`, fail-fast) and the asset tests.
 */
import { loadYamlFile } from "./yaml-loader.js";

export type Stat = "physical" | "wisdom" | "intelligence" | "charisma";
export const STATS: readonly Stat[] = ["physical", "wisdom", "intelligence", "charisma"];

/** Alignment axis vocabularies (e.g. `axis: [lawful, good]`). */
export const LAW_AXIS = ["lawful", "neutral", "chaotic"] as const;
export const MORAL_AXIS = ["good", "neutral", "evil"] as const;

export class AssetSchemaError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly problems: string[],
  ) {
    super(`Asset schema validation failed for ${filePath}:\n  - ${problems.join("\n  - ")}`);
    this.name = "AssetSchemaError";
  }
}

// ── primitives ──

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}
function labelOf(rec: Record<string, unknown>): string {
  return typeof rec.name === "string" && rec.name.trim() !== "" ? rec.name : "(unnamed)";
}

/** A per-entry validator: returns a (possibly empty) list of problem strings. */
export type EntryValidator = (entry: unknown, index: number) => string[];

/** Assert `modifiers` carries all four stats as integers (the NaN-stat guard). */
function checkModifiers(rec: Record<string, unknown>, i: number): string[] {
  const mods = rec.modifiers;
  if (!isRecord(mods)) {
    return [`[${i}] "${labelOf(rec)}": missing "modifiers" object`];
  }
  const errs: string[] = [];
  for (const s of STATS) {
    if (!isInt(mods[s])) {
      errs.push(`[${i}] "${labelOf(rec)}": modifiers.${s} must be an integer (got ${JSON.stringify(mods[s])})`);
    }
  }
  return errs;
}

// ── per-asset validators ──

/** classes.yml · backgrounds.yml · races.yml — identical shape. */
export const validateStatDef: EntryValidator = (entry, i) => {
  if (!isRecord(entry)) return [`[${i}] entry is not an object`];
  const errs: string[] = [];
  if (!isNonEmptyString(entry.name)) errs.push(`[${i}]: "name" must be a non-empty string`);
  if (!isNonEmptyString(entry.description)) errs.push(`[${i}] "${labelOf(entry)}": "description" must be a non-empty string`);
  errs.push(...checkModifiers(entry, i));
  return errs;
};

/** alignments.yml — name, axis: [law, moral], description. */
export const validateAlignment: EntryValidator = (entry, i) => {
  if (!isRecord(entry)) return [`[${i}] entry is not an object`];
  const errs: string[] = [];
  if (!isNonEmptyString(entry.name)) errs.push(`[${i}]: "name" must be a non-empty string`);
  if (!isNonEmptyString(entry.description)) errs.push(`[${i}] "${labelOf(entry)}": "description" must be a non-empty string`);
  const axis = entry.axis;
  const ok =
    Array.isArray(axis) &&
    axis.length === 2 &&
    (LAW_AXIS as readonly string[]).includes(axis[0]) &&
    (MORAL_AXIS as readonly string[]).includes(axis[1]);
  if (!ok) {
    errs.push(
      `[${i}] "${labelOf(entry)}": "axis" must be [law, moral] with law∈{${LAW_AXIS.join("|")}}, moral∈{${MORAL_AXIS.join("|")}} (got ${JSON.stringify(axis)})`,
    );
  }
  return errs;
};

/** day-jobs.yml — depends_on stats, base_income, optional workplace_location, actions. */
export const validateDayJob: EntryValidator = (entry, i) => {
  if (!isRecord(entry)) return [`[${i}] entry is not an object`];
  const errs: string[] = [];
  const name = labelOf(entry);
  if (!isNonEmptyString(entry.name)) errs.push(`[${i}]: "name" must be a non-empty string`);

  const dep = entry.depends_on;
  if (!Array.isArray(dep) || dep.length === 0 || !dep.every((s) => (STATS as readonly string[]).includes(s as string))) {
    errs.push(`[${i}] "${name}": "depends_on" must be a non-empty array of stats (${STATS.join("|")})`);
  }
  if (!isInt(entry.base_income) || (entry.base_income as number) < 0) {
    errs.push(`[${i}] "${name}": "base_income" must be an integer >= 0`);
  }
  const wl = entry.workplace_location;
  if (!(wl === null || wl === undefined || typeof wl === "string")) {
    errs.push(`[${i}] "${name}": "workplace_location" must be a string or null`);
  }
  const actions = entry.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    errs.push(`[${i}] "${name}": "actions" must be a non-empty array`);
  } else {
    actions.forEach((a, j) => {
      if (!isRecord(a) || !isNonEmptyString(a.label) || !isNonEmptyString(a.hook) || !isInt(a.income) || (a.income as number) < 0) {
        errs.push(`[${i}] "${name}": actions[${j}] needs { label, hook, income>=0 }`);
      }
    });
  }
  return errs;
};

/** item-sets.yml — for_classes, items with stat/modifier. */
export const validateItemSet: EntryValidator = (entry, i) => {
  if (!isRecord(entry)) return [`[${i}] entry is not an object`];
  const errs: string[] = [];
  const name = labelOf(entry);
  if (!isNonEmptyString(entry.name)) errs.push(`[${i}]: "name" must be a non-empty string`);
  if (!isNonEmptyString(entry.description)) errs.push(`[${i}] "${name}": "description" must be a non-empty string`);

  const forClasses = entry.for_classes;
  if (!Array.isArray(forClasses) || forClasses.length === 0 || !forClasses.every((c) => isNonEmptyString(c))) {
    errs.push(`[${i}] "${name}": "for_classes" must be a non-empty array of class names`);
  }
  const items = entry.items;
  if (!Array.isArray(items) || items.length === 0) {
    errs.push(`[${i}] "${name}": "items" must be a non-empty array`);
  } else {
    items.forEach((it, j) => {
      if (!isRecord(it)) {
        errs.push(`[${i}] "${name}": items[${j}] is not an object`);
        return;
      }
      if (!isNonEmptyString(it.name)) errs.push(`[${i}] "${name}": items[${j}] needs a "name"`);
      if (typeof it.emoji !== "string") errs.push(`[${i}] "${name}": items[${j}] needs an "emoji" string`);
      if (!(STATS as readonly string[]).includes(it.stat as string)) errs.push(`[${i}] "${name}": items[${j}].stat must be one of ${STATS.join("|")} (got ${JSON.stringify(it.stat)})`);
      if (!isInt(it.modifier)) errs.push(`[${i}] "${name}": items[${j}].modifier must be an integer`);
      if (it.quantity !== undefined && (!isInt(it.quantity) || (it.quantity as number) < 1)) {
        errs.push(`[${i}] "${name}": items[${j}].quantity must be an integer >= 1 when present`);
      }
    });
  }
  return errs;
};

/** release-notes/<tag>.yml — a single object, not an array. */
export function validateReleaseNotes(obj: unknown, expectedTag?: string): string[] {
  if (!isRecord(obj)) return ["release notes file is not an object"];
  const errs: string[] = [];
  if (!isNonEmptyString(obj.tag)) errs.push(`"tag" must be a non-empty string`);
  else if (expectedTag !== undefined && obj.tag !== expectedTag) errs.push(`"tag" (${obj.tag}) must equal the filename tag (${expectedTag})`);
  if (!isNonEmptyString(obj.title)) errs.push(`"title" must be a non-empty string`);
  if (!Array.isArray(obj.highlights) || obj.highlights.length === 0 || !obj.highlights.every((h) => isNonEmptyString(h))) {
    errs.push(`"highlights" must be a non-empty array of strings`);
  }
  if (obj.date !== undefined && typeof obj.date !== "string") errs.push(`"date" must be a string when present`);
  if (obj.notes !== undefined && typeof obj.notes !== "string") errs.push(`"notes" must be a string when present`);
  return errs;
}

// ── loader ──

/**
 * Load a YAML asset file and validate every entry against `validate`. Throws
 * AssetSchemaError listing file + entry index + field on any problem, so a bad
 * asset crashes boot loudly (caught by the deploy test/typecheck gate) instead
 * of producing a silent `null`/NaN downstream. Returns the validated rows.
 */
export function loadAndValidate<T>(filePath: string, validate: EntryValidator): T[] {
  const rows = loadYamlFile(filePath);
  const problems: string[] = [];
  rows.forEach((row, i) => problems.push(...validate(row, i)));
  if (problems.length > 0) throw new AssetSchemaError(filePath, problems);
  return rows as T[];
}

// ── cross-file integrity (T4) ──

interface NamedItemSet {
  name: string;
  for_classes: string[];
}

/**
 * Every kit's `for_classes` ⊆ known class names, AND every class has at least
 * one kit (no class can finish /join kit-less).
 */
export function checkItemSetCoverage(itemSets: NamedItemSet[], classNames: string[]): string[] {
  const known = new Set(classNames);
  const covered = new Set<string>();
  const errs: string[] = [];
  for (const set of itemSets) {
    for (const cls of set.for_classes) {
      if (!known.has(cls)) errs.push(`item-set "${set.name}" lists unknown class "${cls}"`);
      else covered.add(cls);
    }
  }
  for (const cls of classNames) {
    if (!covered.has(cls)) errs.push(`class "${cls}" has no starting kit`);
  }
  return errs;
}

/** Each day-job's `workplace_location` is null or a known (seeded) location name. */
export function checkDayJobLocations(
  dayJobs: Array<{ name: string; workplace_location?: string | null }>,
  locationNames: string[],
): string[] {
  const known = new Set(locationNames);
  const errs: string[] = [];
  for (const job of dayJobs) {
    const wl = job.workplace_location;
    if (wl != null && !known.has(wl)) {
      errs.push(`day-job "${job.name}" workplace_location "${wl}" is not a seeded location`);
    }
  }
  return errs;
}

/** Alignment law×moral combinations are unique (no duplicate cells). */
export function checkAlignmentUniqueness(alignments: Array<{ name: string; axis: [string, string] }>): string[] {
  const seen = new Set<string>();
  const errs: string[] = [];
  for (const a of alignments) {
    const key = `${a.axis[0]}/${a.axis[1]}`;
    if (seen.has(key)) errs.push(`duplicate alignment axis combination ${key} ("${a.name}")`);
    seen.add(key);
  }
  return errs;
}
