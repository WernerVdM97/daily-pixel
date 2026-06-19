import { describe, it, expect } from "vitest";
import path from "node:path";
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
});
