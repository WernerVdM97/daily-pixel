import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * DC-fix/beat-paint-unhandled: a source-level pin over every `beatPaint = ...` assignment in
 * the two files that stash the router's advisory beat-paint promise for a later `await`, so a
 * future edit that adds an unwrapped assignment (or strips `trackPaint(...)` off an existing
 * one) fails a fast, deterministic check rather than relying on an integration test to happen
 * to exercise the exact macrotask-gap timing that would expose it. Companion to (not a
 * replacement for) beat-paint-unhandled.test.ts's end-to-end proof against the real day-job
 * leaf — this test proves ALL FOUR named call sites route through `trackPaint`; the other
 * proves that doing so genuinely stops the process-level page for at least one of them, against
 * the real production code path rather than the helper in isolation.
 *
 * The `action:custom:modal` leaf (~line 329) is the fifth such assignment, and the modal twin of
 * commands/action.ts's `/action <text>` flow: same IIFE, same later await, same LLM-call gap. The
 * fix's original spec enumerated only four sites and missed it; leaving one instance of an
 * identical defect unwrapped would have made this pin read as full coverage while one real path
 * still paged twice, so every assignment in both files is required to be wrapped.
 */

const DISCORD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "discord");

function readSrc(relPath: string): string {
  return readFileSync(path.join(DISCORD_DIR, relPath), "utf8");
}

// Matches every REASSIGNMENT of `beatPaint` (never the `let beatPaint: Promise<void> |
// undefined;` declaration, which has no `=`), capturing whether `trackPaint(` sits immediately
// to the right — the one shape both call sites in scope share, chained or not.
const ASSIGNMENT_RE = /\bbeatPaint\s*=\s*(trackPaint\()?/g;

interface Assignment {
  file: string;
  wrapped: boolean;
}

function findAssignments(file: string, src: string): Assignment[] {
  return [...src.matchAll(ASSIGNMENT_RE)].map((m) => ({ file, wrapped: m[1] !== undefined }));
}

describe("DC-fix/beat-paint-unhandled — every beatPaint assignment in scope is wrapped in trackPaint", () => {
  it("is non-vacuous: the regex actually distinguishes a wrapped assignment from an unwrapped one", () => {
    expect(findAssignments("fake.ts", "beatPaint = trackPaint((async () => {})());")).toEqual([
      { file: "fake.ts", wrapped: true },
    ]);
    expect(findAssignments("fake.ts", "beatPaint = (async () => {})();")).toEqual([
      { file: "fake.ts", wrapped: false },
    ]);
    // The declaration alone (no assignment) must never be picked up as a hit.
    expect(findAssignments("fake.ts", "let beatPaint: Promise<void> | undefined;")).toEqual([]);
  });

  it("dispatchInteraction.ts: all four call sites are wrapped, including the action:custom:modal leaf the original spec missed", () => {
    const src = readSrc("dispatchInteraction.ts");
    const assignments = findAssignments("dispatchInteraction.ts", src);

    // Guard against the walk finding nothing and passing vacuously (a renamed variable, a
    // moved file) — same non-vacuity discipline as structural-boundary.test.ts's file-count
    // guard.
    expect(assignments.length).toBe(4);
    expect(assignments.filter((a) => !a.wrapped)).toEqual([]);
  });

  it("commands/action.ts: its one call site (/action <text>'s loading beat) is wrapped", () => {
    const src = readSrc(path.join("commands", "action.ts"));
    const assignments = findAssignments("commands/action.ts", src);

    expect(assignments).toEqual([{ file: "commands/action.ts", wrapped: true }]);
  });

  it("trackPaint itself is imported (not hand-rolled at the call site) in both files", () => {
    const dispatchSrc = readSrc("dispatchInteraction.ts");
    const actionSrc = readSrc(path.join("commands", "action.ts"));
    expect(dispatchSrc).toContain(`from "./beatPaint.js"`);
    expect(actionSrc).toContain(`from '../beatPaint.js'`);
  });
});
