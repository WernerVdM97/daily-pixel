import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// DC-M9.1 / DC-M9.4.4 — the structural check is a source-regex test over the interaction
// path, not a new dependency (no madge/dependency-cruiser). It bans RUNTIME imports only
// from a banned path (`engine/` or `controller/`, at any `../` depth — see isBannedModule
// below); `import type` is inert at runtime and stays legal (DC-M9.1's reasoning: banning it
// would force pointless DTO duplication). This copies the M8.5 DC-S4 observer pin's shape
// (tests/agent/observer.test.ts), which already proved the "read the file as source, assert
// on it" pattern for this repo.
//
// The check scans every `.ts` file under src/discord/ recursively, not an allow-list — a
// fresh-context review by tamper found that a hardcoded `[dispatchInteraction.ts,
// viewToDiscord.ts, ...commandFiles]` array left most of the directory (format.ts,
// navSupply.ts, CommandRegistry.ts, images.ts, ...) unscanned, which made the DC-M9.1
// exemption list decorative: files that are never scanned don't need naming as exempt.
// DC-M9.1's own wording ("named as out of scope in the test itself with the reason") only
// makes sense against a directory scan.
//
// Four forms of runtime cross-layer dependency are matched, all from a banned path:
//   1. A static import — `import <clause> from '<module>'`.
//   2. A re-export — `export <clause> from '<module>'`. This is the DC-M9.4.3 compat
//      re-export hazard: a re-export still resolves the banned path at runtime, so it
//      is caught by the same clause/type-only rules as a static import (`export type { Foo }
//      from '...'` and `export { type Foo } from '...'` are both inert and stay legal).
//   3. A side-effect-only import — `import '<module>'`, no clause and no `from`. There is
//      no type-only form of this (nothing is bound, but the module still executes at
//      runtime), so any hit is unconditional, exemptions aside.
//   4. A dynamic import — `import('<module>')`, delimited by `'`, `"` or a backtick. There
//      is no type-only form of a dynamic import either (it always evaluates at runtime), so
//      any hit against a banned path is an unconditional match, exemptions aside.
//
// Two parsing hazards, both from DC-M9.4.4, handled below rather than accidentally passed:
//   1. Multi-line import/re-export statements — the check parses STATEMENTS, not lines, by
//      matching `(import|export) <clause> from '<module>'` with a clause that may span
//      newlines.
//   2. The inline type modifier — `import { type Foo, type Bar } from '../engine/x.js'` is
//      equally inert (every binding carries `type`), so it counts as type-only. But
//      `import { type Foo, bar } from '../engine/x.js'` carries a live runtime binding
//      (`bar`) and MUST be caught as a runtime import. The same rule applies to a re-export's
//      clause.

const DISCORD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'discord');

function readSrc(relPath: string): string {
  return readFileSync(path.join(DISCORD_DIR, relPath), 'utf8');
}

// Depth-independent on purpose: a fixed prefix list (`../engine/`, `../../engine/`, ...)
// misses a command file added later in a subdirectory (`commands/foo/bar.ts` would need
// `../../../engine/`). Stripping the leading `../` run and checking what remains makes the
// check blind to depth rather than needing a new prefix every time the tree grows.
function isBannedModule(module: string): boolean {
  const stripped = module.replace(/^(?:\.\.\/)+/, '');
  return stripped.startsWith('engine/') || stripped.startsWith('controller/');
}

interface ImportHit {
  file: string;
  module: string;
  clause: string;
}

// Matches `import <clause> from '<module>'` AND `export <clause> from '<module>'` (a
// re-export, DC-M9.4.3), non-greedy so it stops at the first `from '...'` — which is
// exactly where a real import/re-export statement ends. `[^;]*?` (rather than `.*?`)
// is what lets the clause span multiple lines while still refusing to cross a statement
// boundary: no legal import/re-export clause contains a semicolon, so excluding `;` from
// the clause class stops a bare `export function`/`export const`/... (which has no `from`
// of its own) from lazily absorbing everything up to some unrelated later `from '...'`.
// Anchored to the start of a line (`^[ \t]*`, `m` flag): every real import/export
// declaration in this codebase sits at column 0, and without the anchor the word "import"
// used as ordinary prose inside a preceding doc comment (found live in navSupply.ts —
// "The engine import is type-only...") gets picked up as the clause start, with nothing
// but that comment's own text between it and the real statement's `from` clause below —
// a false positive the widened directory scan surfaced, not a real cross-layer import.
const IMPORT_RE = /^[ \t]*(?:import|export)\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/gm;

// Matches a side-effect-only import — `import '<module>'` — which has no `from` clause at
// all, so IMPORT_RE never sees it. Requires the quote to sit directly after `import` plus
// whitespace, which is exactly what keeps this from also matching `import { x } from '...'`
// (next non-whitespace char there is `{`, not a quote) or a dynamic `import(...)` (next
// char there is `(`). Anchored to line start for the same comment-prose reason as IMPORT_RE.
const SIDE_EFFECT_IMPORT_RE = /^[ \t]*import\s+['"]([^'"]+)['"]/gm;

// Matches a dynamic `import('<module>')` call (optional whitespace before the paren,
// e.g. `await import ('<module>')`), delimited by `'`, `"` or a backtick. No `from` clause
// exists for this form, so it is a separate regex rather than a variant of IMPORT_RE above.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Splits a clause into its brace-list part (if any) and whatever sits outside the braces
// (a default or namespace binding). Shared by isTypeOnlyClause and the key normalizer below
// so both agree on what "outside the braces" means.
function splitBraceClause(trimmed: string): { outside: string; names: string[] | null } {
  const braceMatch = trimmed.match(/\{([\s\S]*)\}/);
  if (!braceMatch) return { outside: trimmed, names: null };
  const outside = (trimmed.slice(0, braceMatch.index) + trimmed.slice(braceMatch.index! + braceMatch[0].length))
    .replace(/,/g, '')
    .trim();
  const names = braceMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
  return { outside, names };
}

// A binding list is type-only if EVERY named binding carries its own `type` modifier,
// or if the whole clause is prefixed with `import type`. A default/namespace binding
// living outside the `{ ... }` list (e.g. `import Default, { type Foo } from ...`) is
// always a runtime binding, `type` modifier or not — TS does not allow `type Default`.
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.replace(/\s+/g, ' ').trim();
  if (/^type\s/.test(trimmed)) return true;

  const { outside, names } = splitBraceClause(trimmed);
  if (outside.length > 0) return false; // default/namespace import, always a runtime binding
  if (names === null) return false; // no braces and no leading `type` — e.g. bare `import Foo from ...`
  if (names.length === 0) return true; // `import {} from '...'` — inert regardless
  return names.every((n) => /^type\s+/.test(n));
}

// Normalizes a clause to a stable, brace-free label for the exemption key, so
// `{ mapError }` and `mapError` (and any incidental whitespace) key the same way.
function normalizeClause(clause: string): string {
  const trimmed = clause.replace(/\s+/g, ' ').trim();
  const { outside, names } = splitBraceClause(trimmed);
  if (names === null) return trimmed;
  const inside = names.join(', ');
  return outside ? `${outside}, { ${inside} }` : inside;
}

// `isBanned` is a parameter rather than a hardcoded call to isBannedModule so the same
// parser serves both directions of the boundary: the DC-M9.1 check below asks "does the
// adapter reach DOWN into engine/controller", and the DC-M10.9 check asks "does anything
// else reach UP into the adapter". Same four import forms, same type-only rules.
function findRuntimeCrossLayerImports(
  file: string,
  src: string,
  isBanned: (module: string) => boolean = isBannedModule,
): ImportHit[] {
  const hits: ImportHit[] = [];
  for (const match of src.matchAll(IMPORT_RE)) {
    const [, clause, module] = match;
    if (!isBanned(module)) continue;
    if (isTypeOnlyClause(clause)) continue;
    hits.push({ file, module, clause: normalizeClause(clause) });
  }
  for (const match of src.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    const [, module] = match;
    if (!isBanned(module)) continue;
    // No type-only form exists for a side-effect import — always a runtime hit.
    hits.push({ file, module, clause: '<side-effect import>' });
  }
  for (const match of src.matchAll(DYNAMIC_IMPORT_RE)) {
    const [, module] = match;
    if (!isBanned(module)) continue;
    // No type-only form exists for a dynamic import — always a runtime hit.
    hits.push({ file, module, clause: '<dynamic import>' });
  }
  return hits;
}

// Recursive on purpose (DC-M9.1's fix): a hardcoded array of the three "obvious" adapter
// files left everything else in src/discord/ (format.ts, navSupply.ts, CommandRegistry.ts,
// images.ts, ...) unscanned, so the DC-M9.1 exemption list below was never exercised against
// most of the directory. Returns paths relative to `dir`, `/`-joined regardless of platform.
function listAllTsFiles(dir: string, relBase = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listAllTsFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.ts')) {
      out.push(rel);
    }
  }
  return out;
}

describe('DC-M9.1 / DC-M9.4.4 structural check — zero runtime engine/controller imports on the interaction path', () => {
  // Named exemptions, not accidental gaps:
  //   - commands/sleep.ts's `mapError` (DC-M9.8): SLEEP_ADMIN_TICK calls `engine.tick(true)`,
  //     an operator affordance, not a game mechanic, so it does not cross the seam.
  //   - Scheduled/broadcast modules are out of scope entirely because they are not on the
  //     interaction path: weekly-recap, afternoon, announcements, pin, release-notes, collapse.
  //     (map-render is NOT named here — it moved to src/render/ in M9.4.1 and is no longer
  //     under src/discord/ at all, so it never appears in the walk below; naming a file that
  //     has moved is the exact mistake DC-M9.4.4 calls out.)
  const OUT_OF_SCOPE_MODULES = new Set([
    'weekly-recap.ts',
    'afternoon.ts',
    'announcements.ts',
    'pin.ts',
    'release-notes.ts',
    'collapse.ts',
  ]);
  const SLEEP_EXEMPTION_KEY = 'commands/sleep.ts:../../engine/ErrorMapper.js:mapError';
  const EXEMPT_HITS = new Set([SLEEP_EXEMPTION_KEY]);

  function keyOf(hit: ImportHit): string {
    return `${hit.file}:${hit.module}:${hit.clause}`;
  }

  it('every .ts file under src/discord/ (scanned recursively, not an allow-list) imports zero runtime engine/controller symbols beyond the named DC-M9.8 exemption', () => {
    const files = listAllTsFiles(DISCORD_DIR)
      .filter((f) => !OUT_OF_SCOPE_MODULES.has(f))
      .sort();
    // Guard against the walk silently matching nothing (e.g. a path typo) and passing
    // vacuously — DC-M9.4.4's non-vacuity requirement applied to the walk itself.
    expect(files.length).toBeGreaterThanOrEqual(19);

    const allHits = files.flatMap((f) => findRuntimeCrossLayerImports(f, readSrc(f)));
    const unexempted = allHits.filter((h) => !EXEMPT_HITS.has(keyOf(h)));

    expect(unexempted).toEqual([]);
    // The one live exemption must actually be present — proves the exemption isn't stale
    // (e.g. naming a symbol/file that has since moved, the map-render mistake this test avoids).
    expect(allHits.some((h) => keyOf(h) === SLEEP_EXEMPTION_KEY)).toBe(true);
  });
});

describe('DC-M9.4.5 — the six DC-M9.3.12 call sites in dispatchInteraction.ts, pinned by name and count', () => {
  // DC-M9.3.12: `controller.needsCharacterGate` and `controller.stampLastPlayed` stay because
  // neither is a game action with an event to become, and the router deliberately does NOT
  // stamp on the six screen events (double-stamping is the bug that comment avoids) — so the
  // dispatcher's own stamps are load-bearing, not leftovers. `engine.getMeta(META_RECAP_THREAD_ID)`
  // is the weekly-recap broadcast thread lookup, also a transport concern rather than a game
  // mechanic. DC-M9.1's structural check is import-based and cannot see these calls at all
  // (WorldEngine/SessionController are `import type` only in this file), so this pin is the
  // only net for a seventh call site sneaking in. Pinned on method name + count, NOT line
  // numbers, per DC-M9.4.5 — a line-number pin is a maintenance tax that gets deleted the
  // first time the file shifts, and would not survive even an unrelated edit above it.
  const DISPATCH_SRC = readSrc('dispatchInteraction.ts');

  function countOccurrences(src: string, needle: string): number {
    return src.split(needle).length - 1;
  }

  // Review fix: the count/name pin above matches literal `controller.`/`engine.` text, so a
  // one-line alias or destructure rename defeats it silently — `const ctrl = controller;
  // ctrl.stampLastPlayed(...)` never contains the string `controller.stampLastPlayed`. These
  // two patterns catch that class of indirection: a bare alias assignment (`= controller`,
  // `= engine`, `= deps.controller`, `= deps.engine`) and a destructuring rename (`const
  // { controller: ctrl }`, `const { engine: x }`). The file legitimately destructures both
  // under their OWN names (`const { engine, controller, ... } = deps;`), which has no colon
  // and so is not a rename — that must and does keep passing.
  //
  // Residual limit, stated plainly rather than implied away: this is a source-regex check,
  // not dataflow analysis. It cannot see `controller` passed as a plain argument into a
  // helper function and re-bound there under a different local name — that indirection is
  // real and this pin does not close it. It raises the bar against the ordinary-refactor
  // shape a reviewer actually reproduced; it is not an airtight barrier.
  const ALIAS_ASSIGNMENT_RE = /(?<![=!<>])=(?!=)\s*(?:deps\.)?(controller|engine)\b/g;
  const DESTRUCTURE_RE = /\b(?:const|let)\s*\{([^}]*)\}/g;
  const DESTRUCTURE_RENAME_RE = /\b(?:controller|engine)\s*:\s*\w+/g;

  function findAliasHits(src: string): string[] {
    const hits: string[] = [];
    for (const match of src.matchAll(ALIAS_ASSIGNMENT_RE)) {
      hits.push(`alias-assignment: = ${match[1]}`);
    }
    for (const match of src.matchAll(DESTRUCTURE_RE)) {
      for (const rename of match[1].matchAll(DESTRUCTURE_RENAME_RE)) {
        hits.push(`destructure-rename: ${rename[0].trim()}`);
      }
    }
    return hits;
  }

  it('has exactly the six named call sites — no more, no fewer, and no alias/destructure dodge', () => {
    expect(countOccurrences(DISPATCH_SRC, 'controller.needsCharacterGate')).toBe(1);
    expect(countOccurrences(DISPATCH_SRC, 'controller.stampLastPlayed')).toBe(2);
    expect(countOccurrences(DISPATCH_SRC, 'engine.getMeta(META_RECAP_THREAD_ID)')).toBe(3);

    // Belt-and-braces: a seventh call site under a DIFFERENT method name (which the
    // three counts above cannot see) must also trip this test.
    const controllerCalls = DISPATCH_SRC.match(/\bcontroller\.\w+/g) ?? [];
    const engineCalls = DISPATCH_SRC.match(/\bengine\.\w+/g) ?? [];
    const allowed = new Set(['controller.needsCharacterGate', 'controller.stampLastPlayed', 'engine.getMeta']);
    const unexpected = [...controllerCalls, ...engineCalls].filter((c) => !allowed.has(c));
    expect(unexpected).toEqual([]);

    // The alias/destructure dodge: a rename must trip this test even though it leaves
    // zero occurrences of the literal strings the three counts above look for.
    expect(findAliasHits(DISPATCH_SRC)).toEqual([]);
  });
});

describe('DC-M10.9 — the boundary in the other direction: nothing outside src/discord/ imports it, except the composition root', () => {
  // The mirror of the DC-M9.1 check, and the reason it exists is that the arc kept
  // rediscovering this edge rather than being told about it. M9's own recon (finding: "the
  // layering inversion runs both ways") found `SessionController` and `mapScreen` importing
  // out of src/discord/; M9.4 moved those two modules and CREATED a fresh one in the same
  // slice (`src/render/map-render.ts` -> `src/discord/format.js`), which nothing caught
  // because the M9.4 check only ever looked downward. M10.1 rehomed the display-vocabulary
  // half of format.ts to src/render/format.ts, which cleared the last of them — so this
  // check is what stops the next slice from quietly opening another.
  //
  // `src/index.ts` is exempt by role, not by accident: it is the composition root, so wiring
  // the adapter to everything else is precisely its job. Every OTHER module under src/ is in
  // scope, which is what makes the exemption meaningful rather than a hole.
  const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const COMPOSITION_ROOT = 'index.ts';

  // `discord.js` (the npm package) is emphatically NOT the src/discord/ directory. Matching
  // on a bare `discord` substring would flag every `from 'discord.js'` in the tree, so the
  // predicate requires a relative specifier resolving into the directory.
  function importsIntoDiscordDir(module: string): boolean {
    if (!module.startsWith('.')) return false; // bare package specifier, e.g. 'discord.js'
    const stripped = module.replace(/^\.\/|^(?:\.\.\/)+/, '');
    return stripped.startsWith('discord/');
  }

  it('no module under src/ outside the adapter (and outside index.ts) imports src/discord/ at runtime', () => {
    const files = listAllTsFiles(SRC_DIR)
      .filter((f) => !f.startsWith('discord/') && f !== COMPOSITION_ROOT)
      .sort();
    // Non-vacuity on the walk itself, same as the DC-M9.1 check: a path typo returning zero
    // files would pass this test while proving nothing.
    expect(files.length).toBeGreaterThanOrEqual(50);

    const hits = files.flatMap((f) =>
      findRuntimeCrossLayerImports(f, readFileSync(path.join(SRC_DIR, f), 'utf8'), importsIntoDiscordDir),
    );
    expect(hits).toEqual([]);
  });

  it('is non-vacuous: the same predicate DOES flag an inbound import, proven in-file rather than by a commit-message tamper', () => {
    // DC-M9.4.6's stronger form — the negative case runs on every suite run instead of
    // living in a commit body someone has to trust. The three forms that must all be caught
    // are the ones the M9.4 review found easy to miss: a plain import, a re-export (the
    // DC-M9.4.3 compat-re-export hazard), and an inline-type clause carrying one live
    // binding among type-only ones.
    const plain = findRuntimeCrossLayerImports(
      'fake/screen.ts',
      `import { SEPARATOR } from '../discord/format.js';`,
      importsIntoDiscordDir,
    );
    const reExport = findRuntimeCrossLayerImports(
      'fake/screen.ts',
      `export { SEPARATOR } from '../discord/format.js';`,
      importsIntoDiscordDir,
    );
    const mixedTypeClause = findRuntimeCrossLayerImports(
      'fake/screen.ts',
      `import { type NavFacts, getNavButtons } from '../discord/format.js';`,
      importsIntoDiscordDir,
    );
    expect(plain).toHaveLength(1);
    expect(reExport).toHaveLength(1);
    expect(mixedTypeClause).toHaveLength(1);

    // ...and the legal shapes stay legal: a type-only import is inert at runtime, and
    // `discord.js` the npm package must never be confused with src/discord/ the directory.
    expect(
      findRuntimeCrossLayerImports(
        'fake/screen.ts',
        `import type { NavFacts } from '../discord/CommandRegistry.js';`,
        importsIntoDiscordDir,
      ),
    ).toEqual([]);
    expect(
      findRuntimeCrossLayerImports(
        'fake/screen.ts',
        `import { EmbedBuilder } from 'discord.js';`,
        importsIntoDiscordDir,
      ),
    ).toEqual([]);
  });
});
