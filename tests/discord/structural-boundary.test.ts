import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// DC-M9.1 / DC-M9.4.4 — the structural check is a source-regex test over the interaction
// path, not a new dependency (no madge/dependency-cruiser). It bans RUNTIME imports only
// from '../engine/', '../controller/', '../../engine/', '../../controller/'; `import type`
// is inert at runtime and stays legal (DC-M9.1's reasoning: banning it would force pointless
// DTO duplication). This copies the M8.5 DC-S4 observer pin's shape (tests/agent/observer.test.ts),
// which already proved the "read the file as source, assert on it" pattern for this repo.
//
// Three forms of runtime cross-layer dependency are matched, all from a banned prefix:
//   1. A static import — `import <clause> from '<module>'`.
//   2. A re-export — `export <clause> from '<module>'`. This is the DC-M9.4.3 compat
//      re-export hazard: a re-export still resolves the banned path at runtime, so it
//      is caught by the same clause/type-only rules as a static import (`export type { Foo }
//      from '...'` and `export { type Foo } from '...'` are both inert and stay legal).
//   3. A dynamic import — `import('<module>')`. There is no type-only form of a dynamic
//      import (it always evaluates at runtime), so any hit against a banned prefix is an
//      unconditional match, exemptions aside.
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

const BANNED_PREFIXES = ['../engine/', '../controller/', '../../engine/', '../../controller/'];

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
const IMPORT_RE = /\b(?:import|export)\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;

// Matches a dynamic `import('<module>')` call (optional whitespace before the paren,
// e.g. `await import ('<module>')`). No `from` clause exists for this form, so it is a
// separate regex rather than a variant of IMPORT_RE above.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;

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

function findRuntimeCrossLayerImports(file: string, src: string): ImportHit[] {
  const hits: ImportHit[] = [];
  for (const match of src.matchAll(IMPORT_RE)) {
    const [, clause, module] = match;
    if (!BANNED_PREFIXES.some((p) => module.startsWith(p))) continue;
    if (isTypeOnlyClause(clause)) continue;
    hits.push({ file, module, clause: normalizeClause(clause) });
  }
  for (const match of src.matchAll(DYNAMIC_IMPORT_RE)) {
    const [, module] = match;
    if (!BANNED_PREFIXES.some((p) => module.startsWith(p))) continue;
    // No type-only form exists for a dynamic import — always a runtime hit.
    hits.push({ file, module, clause: '<dynamic import>' });
  }
  return hits;
}

describe('DC-M9.1 / DC-M9.4.4 structural check — zero runtime engine/controller imports on the interaction path', () => {
  // Named exemptions, not accidental gaps:
  //   - commands/sleep.ts's `mapError` (DC-M9.8): SLEEP_ADMIN_TICK calls `engine.tick(true)`,
  //     an operator affordance, not a game mechanic, so it does not cross the seam.
  //   - Scheduled/broadcast modules are out of scope entirely because they are not on the
  //     interaction path: weekly-recap, afternoon, announcements, pin, release-notes, collapse.
  //     (map-render is NOT exempted here — it moved to src/render/ in M9.4.1 and is no longer
  //     under src/discord/ at all, so it does not appear in the glob below.)
  const SLEEP_EXEMPTION_KEY = 'commands/sleep.ts:../../engine/ErrorMapper.js:mapError';
  const EXEMPT_HITS = new Set([SLEEP_EXEMPTION_KEY]);

  function keyOf(hit: ImportHit): string {
    return `${hit.file}:${hit.module}:${hit.clause}`;
  }

  it('dispatchInteraction.ts, viewToDiscord.ts and every commands/*.ts file (globbed, not hardcoded) import zero runtime engine/controller symbols beyond the named DC-M9.8 exemption', () => {
    // Directory listing rather than a hardcoded array so a command file added later is
    // picked up automatically, per DC-M9.4.4.
    const commandFiles = readdirSync(path.join(DISCORD_DIR, 'commands'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `commands/${f}`)
      .sort();
    const files = ['dispatchInteraction.ts', 'viewToDiscord.ts', ...commandFiles];
    // Guard against the directory listing silently matching nothing (e.g. a path typo)
    // and passing vacuously.
    expect(commandFiles.length).toBeGreaterThanOrEqual(13);

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

  it('has exactly the six named call sites — no more, no fewer', () => {
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
  });
});
