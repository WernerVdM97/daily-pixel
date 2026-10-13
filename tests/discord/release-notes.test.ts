import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadReleaseNotes,
  buildReleaseNotesMessage,
} from "../../src/discord/release-notes.js";

const NOTES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "release-notes",
);

describe("loadReleaseNotes", () => {
  it("loads the shipped v0.2.3 notes with a title and highlights", () => {
    const rn = loadReleaseNotes("v0.2.3", NOTES_DIR);
    expect(rn).not.toBeNull();
    expect(rn!.tag).toBe("v0.2.3");
    expect(rn!.title.length).toBeGreaterThan(0);
    expect(rn!.highlights.length).toBeGreaterThan(0);
  });

  // A break in this path only ever shows on a release boot, so every shipped file is read the
  // way the boot reads it rather than only the one tag a player happened to trigger.
  it("loads every shipped tag's notes", () => {
    const tags = fs
      .readdirSync(NOTES_DIR)
      .filter((f) => f.endsWith(".yml"))
      .map((f) => f.replace(/\.yml$/, ""));
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const rn = loadReleaseNotes(tag, NOTES_DIR);
      expect(rn, tag).not.toBeNull();
      expect(rn!.tag, tag).toBe(tag);
      expect(rn!.highlights.length, tag).toBeGreaterThan(0);
    }
  });

  it("returns null for a tag with no notes file", () => {
    expect(loadReleaseNotes("v99.99.99", NOTES_DIR)).toBeNull();
  });
});

describe("buildReleaseNotesMessage", () => {
  it("renders the tag, title, highlights, and a feedback prompt", () => {
    const msg = buildReleaseNotesMessage({
      tag: "v0.2.3",
      title: "The Weekend Update",
      date: "2026-06-18",
      highlights: ["First thing", "Second thing"],
      notes: "Thanks for playing.",
    });
    expect(msg).toContain("v0.2.3");
    expect(msg).toContain("The Weekend Update");
    expect(msg).toContain("• First thing");
    expect(msg).toContain("• Second thing");
    expect(msg).toContain("Thanks for playing.");
    expect(msg).toContain("Request / Feedback");
  });

  it("omits the optional date and notes when absent", () => {
    const msg = buildReleaseNotesMessage({
      tag: "v0.4.0",
      title: "Minimal",
      highlights: ["Only highlight"],
    });
    expect(msg).toContain("v0.4.0: Minimal");
    expect(msg).toContain("• Only highlight");
    expect(msg).not.toContain("undefined");
  });

  it("uses the 📬 emoji for release notes", () => {
    const msg = buildReleaseNotesMessage({
      tag: "v0.2.8",
      title: "Polish",
      highlights: ["A fix"],
    });
    expect(msg.startsWith("📬")).toBe(true);
  });
});
