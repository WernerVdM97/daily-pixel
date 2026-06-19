import { describe, it, expect } from "vitest";
import { collapseNotice } from "../../src/discord/collapse.js";

describe("collapseNotice", () => {
  it("fires on a health transition to 0, naming the character", () => {
    const notice = collapseNotice("Aldric", { health: 3, stamina: 5 }, { health: 0, stamina: 5 });
    expect(notice).toContain("Aldric");
    expect(notice).toContain("collapsed");
    expect(notice).not.toContain("spent");
  });

  it("fires on a stamina transition to 0", () => {
    const notice = collapseNotice("Bram", { health: 5, stamina: 2 }, { health: 5, stamina: 0 });
    expect(notice).toContain("Bram");
    expect(notice).toContain("spent");
    expect(notice).not.toContain("collapsed");
  });

  it("fires both when health and stamina bottom out together", () => {
    const notice = collapseNotice("Kara", { health: 1, stamina: 1 }, { health: 0, stamina: 0 });
    expect(notice).toContain("collapsed");
    expect(notice).toContain("spent");
  });

  it("does not fire when already at 0 (no transition)", () => {
    expect(collapseNotice("Aldric", { health: 0, stamina: 0 }, { health: 0, stamina: 0 })).toBeNull();
  });

  it("does not fire when vitals stay above 0", () => {
    expect(collapseNotice("Aldric", { health: 5, stamina: 5 }, { health: 3, stamina: 4 })).toBeNull();
  });

  it("returns null when either snapshot is missing", () => {
    expect(collapseNotice("Aldric", null, { health: 0, stamina: 0 })).toBeNull();
    expect(collapseNotice("Aldric", { health: 1, stamina: 1 }, undefined)).toBeNull();
  });
});
