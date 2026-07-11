import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSleepCommand } from "../../src/discord/commands/sleep.js";
import { buildMorningAnnouncement } from "../../src/discord/announcements.js";

import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";

// Set up admin user ID before importing the sleep command
const ADMIN_ID = 'admin-123';
process.env.ADMIN_USER_ID = ADMIN_ID;

describe("/sleep", () => {
  describe("non-admin", () => {
    /* ── Guards ── */

    it("blocks sleep when rolls remain", async () => {
      const engine = new MockWorldEngine();
      engine.setCharacter(MockWorldEngine.defaultCharacter({ rollsRemaining: 1 }));
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: 'user' } });

      expect(result).toContain("Cannot rest now");
      expect(result).toContain("actions left");
      expect(engine.calls.restAtOak).toHaveLength(0);
    });

    it("blocks sleep when mid-action", async () => {
      const engine = new MockWorldEngine();
      engine.setCharacter(MockWorldEngine.defaultCharacter({
        rollsRemaining: 0,
        lastActionState: { rawInput: "hunt", decisions: [], accumulatedDc: 10 },
      }));
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: 'user' } });

      expect(result).toContain("Cannot rest now");
      expect(result).toContain("mid-action");
      expect(engine.calls.restAtOak).toHaveLength(0);
    });

    /* ── Successful rest scenes ── */

    it("moves location to the Oak and shows arriving flavour", async () => {
      const engine = new MockWorldEngine();
      engine.setCharacter(MockWorldEngine.defaultCharacter({
        rollsRemaining: 0,
        location: "Dark Forest",
      }));
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: 'traveller' } });

      expect(result).toContain("The Warden's Oak");
      expect(result).toContain("bank the fire");
      expect(result).toContain("day turns when the world wills it");
      expect(engine.calls.restAtOak).toHaveLength(1);
      expect(engine.calls.restAtOak[0]).toBe('traveller');
    });

    it("G2: warns about the unsafe-rest HP cost and names the cause plainly", async () => {
      const engine = new MockWorldEngine();
      engine.setCharacter(MockWorldEngine.defaultCharacter({
        rollsRemaining: 0,
        location: "The Broken Keep",
        health: 8,
        maxHealth: 10,
      }));
      // Resting here is unsafe (not the Oak, not a workplace).
      engine.setLocation({ name: "The Broken Keep", description: "Ruins.", tags: ["ruins"], isSafe: false });
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: 'wanderer' } });

      // The rule is surfaced, the cause is named, and the fix is stated.
      expect(result).toContain("Resting on unsafe ground costs 1 HP");
      expect(result).toContain("The Broken Keep");
      expect(result).toContain("lost **1 HP**");
      expect(result).toContain("before");
      expect(engine.calls.modifyHealth).toHaveLength(1);
      expect(engine.calls.modifyHealth[0].amount).toBe(-1);
    });

    it("uses familiar-boughs flavour when already at the Oak", async () => {
      const engine = new MockWorldEngine();
      engine.setCharacter(MockWorldEngine.defaultCharacter({
        rollsRemaining: 0,
        location: "The Warden's Oak",
      }));
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: 'local' } });

      expect(result).toContain("The Warden's Oak");
      expect(result).toContain("familiar boughs");
      expect(result).not.toContain("bank the fire");
      expect(engine.calls.restAtOak).toHaveLength(1);
    });

    it("returns character-needed message when no character exists", async () => {
      const engine = new MockWorldEngine();
      engine.setCharacter(null);
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: 'nobody' } });

      expect(result).toContain("don't have a character");
      expect(result).toContain("/join");
      expect(engine.calls.restAtOak).toHaveLength(0);
    });
  });

  describe("admin — tick", () => {
    beforeEach(() => { process.env.SLEEP_ADMIN_TICK = 'true'; });
    afterEach(() => { delete process.env.SLEEP_ADMIN_TICK; });

    it("returns day transition message", async () => {
      const engine = new MockWorldEngine();
      engine.setTickResult({ dayNumber: 2, playersAffected: 1, npcMovements: [{ npcId: 5, npcName: 'Merchant', fromLocation: 'Oak', toLocation: 'Town' }] });
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: ADMIN_ID } });

      expect(result).toContain("Day 2");
      expect(result).toContain("begins");
      expect(result).toContain("/hi");
      expect(result).toContain("Oak");
    });

    it("shares the morning builder with the live cron announcement — same day, same prose", async () => {
      const engine = new MockWorldEngine();
      engine.setTickResult({ dayNumber: 1, playersAffected: 1, npcMovements: [] });
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: ADMIN_ID } });

      expect(result).toBe(
        buildMorningAnnouncement({ day: 1, playersAffected: 1, npcMovementCount: 0 }),
      );
    });

    it("includes player/NPC count when changes happened", async () => {
      const engine = new MockWorldEngine();
      engine.setTickResult({ dayNumber: 3, playersAffected: 1, npcMovements: [{ npcId: 1, npcName: 'Hunter', fromLocation: 'Forest', toLocation: 'Glade' }] });
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: ADMIN_ID } });

      expect(result).toContain("soul(s) stirred");
      expect(result).toContain("NPC(s) on the move");
    });

    it("rotates flavour prose deterministically by day, not a fixed early/late split", async () => {
      const engine = new MockWorldEngine();
      engine.setTickResult({ dayNumber: 5, playersAffected: 1, npcMovements: [] });
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: ADMIN_ID } });

      expect(result).toBe(
        buildMorningAnnouncement({ day: 5, playersAffected: 1, npcMovementCount: 0 }),
      );
    });

    it("omits count line when nothing changed", async () => {
      const engine = new MockWorldEngine();
      engine.setTickResult({ dayNumber: 2, playersAffected: 0, npcMovements: [] });
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: ADMIN_ID } });

      expect(result).not.toContain("soul(s) stirred");
      expect(result).not.toContain("NPC(s) on the move");
    });

    it("returns user-friendly message on tick error", async () => {
      const engine = {
        tick: () => { throw new Error('Database not initialized'); },
      } as unknown as MockWorldEngine;
      const handler = makeSleepCommand(engine);
      const result = await handler({ user: { id: ADMIN_ID } });

      expect(result).toContain('The warden has been notified');
      expect(result).not.toContain('Database not initialized');
    });
  });

  /* ── Init ── */

  it("warns when ADMIN_USER_ID is unset", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const prev = process.env.ADMIN_USER_ID;
    delete process.env.ADMIN_USER_ID;

    makeSleepCommand(new MockWorldEngine());

    expect(warn).toHaveBeenCalledWith(
      '[sleep] WARNING: ADMIN_USER_ID is not set. Admin `/sleep` will be unreachable —',
      'the world can only advance via nightly cron. Set this env var to enable admin tick.',
    );

    process.env.ADMIN_USER_ID = prev;
    warn.mockRestore();
  });
});
