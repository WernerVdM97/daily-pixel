import { describe, it, expect } from "vitest";
import {
  buildMorningAnnouncement,
  buildEveningAnnouncement,
} from "../../src/discord/announcements.js";

describe("morning announcement", () => {
  it("carries the day number and the call to action", () => {
    const msg = buildMorningAnnouncement({
      day: 1,
      playersAffected: 0,
      npcMovementCount: 0,
    });
    expect(msg).toContain("Day 1 begins");
    expect(msg).toContain("/hi");
  });

  it("is deterministic — the same day renders the same prose every time", () => {
    const data = { day: 12, playersAffected: 2, npcMovementCount: 1 };
    const first = buildMorningAnnouncement(data);
    const second = buildMorningAnnouncement(data);
    expect(first).toBe(second);
  });

  it("rotates flavour across at least two distinct variants over a week of days", () => {
    const variants = new Set(
      Array.from({ length: 7 }, (_, i) =>
        buildMorningAnnouncement({ day: i, playersAffected: 0, npcMovementCount: 0 }),
      ),
    );
    expect(variants.size).toBeGreaterThan(1);
  });

  it("includes the stirred/moved line only when either count is positive", () => {
    const quiet = buildMorningAnnouncement({ day: 3, playersAffected: 0, npcMovementCount: 0 });
    expect(quiet).not.toContain("soul(s) stirred");

    const busy = buildMorningAnnouncement({ day: 3, playersAffected: 4, npcMovementCount: 2 });
    expect(busy).toContain("4 soul(s) stirred, 2 NPC(s) on the move.");
  });

  it("folds in the Saturday threat heads-up when supplied, and omits it otherwise", () => {
    const withThreat = buildMorningAnnouncement({
      day: 5,
      playersAffected: 0,
      npcMovementCount: 0,
      threatHeadsUp: "⚔️ **The weekend brings danger.**",
    });
    expect(withThreat).toContain("⚔️ **The weekend brings danger.**");

    const withoutThreat = buildMorningAnnouncement({
      day: 5,
      playersAffected: 0,
      npcMovementCount: 0,
    });
    expect(withoutThreat).not.toContain("⚔️");
  });
});

describe("evening announcement", () => {
  it("warns about souls still out when the count is positive", () => {
    const msg = buildEveningAnnouncement({ day: 4, soulsInUnsafe: 2 });
    expect(msg).toContain("**2** soul(s) are still out");
    expect(msg).toContain("Will they make it back?");
  });

  it("reads as all-clear when nobody is out", () => {
    const msg = buildEveningAnnouncement({ day: 4, soulsInUnsafe: 0 });
    expect(msg).toContain("Every soul is home");
    expect(msg).toContain("Dawn comes when the world wills it.");
  });

  it("is deterministic — the same day renders the same prose every time", () => {
    const data = { day: 9, soulsInUnsafe: 1 };
    expect(buildEveningAnnouncement(data)).toBe(buildEveningAnnouncement(data));
  });

  it("rotates flavour across at least two distinct variants over a week of days", () => {
    const variants = new Set(
      Array.from({ length: 7 }, (_, i) => buildEveningAnnouncement({ day: i, soulsInUnsafe: 0 })),
    );
    expect(variants.size).toBeGreaterThan(1);
  });
});
