import { describe, it, expect } from "vitest";
import {
  buildMorningAnnouncement,
  buildEveningAnnouncement,
  isMorningSuppressedDay,
  morningSkipReason,
  goodnightSkipReason,
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

describe("isMorningSuppressedDay", () => {
  // Fixed UTC dates — Sun 0, Mon 1, Tue 2, Wed 3, Thu 4, Fri 5, Sat 6.
  it("is true on the days the midday beat owns: Sunday, Wednesday, Saturday", () => {
    expect(isMorningSuppressedDay(new Date("2026-08-02T05:30:00Z"))).toBe(true); // Sun
    expect(isMorningSuppressedDay(new Date("2026-08-05T05:30:00Z"))).toBe(true); // Wed
    expect(isMorningSuppressedDay(new Date("2026-08-08T05:30:00Z"))).toBe(true); // Sat
  });

  it("is false on the other weekdays", () => {
    expect(isMorningSuppressedDay(new Date("2026-08-03T05:30:00Z"))).toBe(false); // Mon
    expect(isMorningSuppressedDay(new Date("2026-08-04T05:30:00Z"))).toBe(false); // Tue
    expect(isMorningSuppressedDay(new Date("2026-08-06T05:30:00Z"))).toBe(false); // Thu
    expect(isMorningSuppressedDay(new Date("2026-08-07T05:30:00Z"))).toBe(false); // Fri
  });
});

describe("morningSkipReason", () => {
  it("already-posted wins over everything, including a stalled tick and a suppressed weekday", () => {
    expect(
      morningSkipReason({ alreadyPosted: true, tickCompleted: true, weekday: 6 }),
    ).toBe("already-posted");
    expect(
      morningSkipReason({ alreadyPosted: true, tickCompleted: false, weekday: 0 }),
    ).toBe("already-posted");
  });

  it("tick-incomplete wins over suppressed-weekday (stall alert must survive suppressed days)", () => {
    expect(
      morningSkipReason({ alreadyPosted: false, tickCompleted: false, weekday: 0 }),
    ).toBe("tick-incomplete");
    expect(
      morningSkipReason({ alreadyPosted: false, tickCompleted: false, weekday: 6 }),
    ).toBe("tick-incomplete");
  });

  it("reports suppressed-weekday on a completed tick for each suppressed day", () => {
    for (const weekday of [0, 3, 6]) {
      expect(
        morningSkipReason({ alreadyPosted: false, tickCompleted: true, weekday }),
      ).toBe("suppressed-weekday");
    }
  });

  it("returns null when posting is fine — a normal weekday with a completed tick", () => {
    expect(
      morningSkipReason({ alreadyPosted: false, tickCompleted: true, weekday: 1 }),
    ).toBeNull();
  });
});

describe("goodnightSkipReason", () => {
  it("already-posted wins regardless of activity", () => {
    expect(
      goodnightSkipReason({ alreadyPosted: true, activePlayersToday: 0 }),
    ).toBe("already-posted");
    expect(
      goodnightSkipReason({ alreadyPosted: true, activePlayersToday: 3 }),
    ).toBe("already-posted");
  });

  it("reports no-activity when nobody played today", () => {
    expect(
      goodnightSkipReason({ alreadyPosted: false, activePlayersToday: 0 }),
    ).toBe("no-activity");
  });

  it("returns null when at least one player engaged today", () => {
    expect(
      goodnightSkipReason({ alreadyPosted: false, activePlayersToday: 1 }),
    ).toBeNull();
  });
});
