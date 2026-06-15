import { describe, it, expect, vi } from "vitest";
import { makeSleepCommand } from "../../src/discord/commands/sleep.js";

import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";

// Set up admin user ID before importing the sleep command
const ADMIN_ID = 'admin-123';
process.env.ADMIN_USER_ID = ADMIN_ID;

describe("/sleep", () => {
  describe("non-admin", () => {
    it("returns rest scene and moves location to the Oak", async () => {
      const engine = new MockWorldEngine();
      engine.setCharacter(MockWorldEngine.defaultCharacter({ location: "Dark Forest" }));
      const handler = makeSleepCommand(engine);
      const result = await handler({
        user: { id: 'non-admin-user' },
      });

      expect(result).toContain("The Warden's Oak");
      expect(result).toContain("bank the fire");
      expect(result).toContain("day turns when the world wills it");
      expect(result).not.toContain("Day");
      expect(result).not.toContain("begins");

      // Verify the engine was called
      expect(engine.calls.restAtOak).toHaveLength(1);
      expect(engine.calls.restAtOak[0]).toBe('non-admin-user');
    });

    it("uses familiar-boughs flavour when already at the Oak", async () => {
      const engine = new MockWorldEngine();
      // Default character is already at the Oak
      engine.setCharacter(MockWorldEngine.defaultCharacter({ location: "The Warden's Oak" }));
      const handler = makeSleepCommand(engine);
      const result = await handler({
        user: { id: 'another-user' },
      });

      expect(result).toContain("The Warden's Oak");
      expect(result).toContain("familiar boughs");
      expect(result).not.toContain("bank the fire");
    });

    it("returns character-needed message when no character exists", async () => {
      const engine = new MockWorldEngine();
      engine.setCharacter(null);
      const handler = makeSleepCommand(engine);
      const result = await handler({
        user: { id: 'nobody' },
      });

      expect(result).toContain("don't have a character");
      expect(result).toContain("/join");
    });
  });

  describe("admin", () => {
    it("returns day transition message for admin user", async () => {
      const engine = new MockWorldEngine();
      engine.setTickResult({ dayNumber: 2, playersAffected: 1, npcMovements: [{ npcId: 5, npcName: 'Merchant', fromLocation: 'Oak', toLocation: 'Town' }] });
      const handler = makeSleepCommand(engine);
      const result = await handler({
        user: { id: ADMIN_ID },
      });

      expect(result).toContain("Day 2");
      expect(result).toContain("begins");
      expect(result).toContain("/hi");
      expect(result).toContain("Oak");
    });

    it("includes scaling flavor for early days", async () => {
      const engine = new MockWorldEngine();
      engine.setTickResult({ dayNumber: 1, playersAffected: 1, npcMovements: [] });
      const handler = makeSleepCommand(engine);
      const result = await handler({
        user: { id: ADMIN_ID },
      });

      expect(result).toContain("fire crackles");
    });

    it("includes player/NPC count in admin response when changes happened", async () => {
      const engine = new MockWorldEngine();
      engine.setTickResult({ dayNumber: 3, playersAffected: 1, npcMovements: [{ npcId: 1, npcName: 'Hunter', fromLocation: 'Forest', toLocation: 'Glade' }] });
      const handler = makeSleepCommand(engine);
      const result = await handler({
        user: { id: ADMIN_ID },
      });

      expect(result).toContain("soul(s) stirred");
      expect(result).toContain("NPC(s) on the move");
    });

    it("uses scaled flavor after day 3", async () => {
      const engine = new MockWorldEngine();
      engine.setTickResult({ dayNumber: 5, playersAffected: 1, npcMovements: [] });
      const handler = makeSleepCommand(engine);
      const result = await handler({
        user: { id: ADMIN_ID },
      });

      expect(result).toContain("smoke");
      expect(result).toContain("thickened");
      expect(result).toContain("hasn't spoken");
    });

    it("does not include player/NPC count line when nothing changed", async () => {
      const engine = new MockWorldEngine();
      engine.setTickResult({ dayNumber: 2, playersAffected: 0, npcMovements: [] });
      const handler = makeSleepCommand(engine);
      const result = await handler({
        user: { id: ADMIN_ID },
      });

      expect(result).not.toContain("soul(s) stirred");
      expect(result).not.toContain("NPC(s) on the move");
    });

    it("returns user-friendly message when tick throws", async () => {
      const engine = {
        tick: () => { throw new Error('Database not initialized'); },
      } as unknown as MockWorldEngine;
      const handler = makeSleepCommand(engine);
      const result = await handler({
        user: { id: ADMIN_ID },
      });

      // Should use mapError fallback instead of raw rejection
      expect(result).toContain('The warden has been notified');
      expect(result).not.toContain('Database not initialized');
    });
  });

  it("warns at handler creation when ADMIN_USER_ID is unset", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Temporarily clear env var for this test
    const prev = process.env.ADMIN_USER_ID;
    delete process.env.ADMIN_USER_ID;

    new MockWorldEngine();
    // Constructor doesn't trigger warning — it's in makeSleepCommand
    makeSleepCommand(new MockWorldEngine());

    expect(warn).toHaveBeenCalledWith(
      '[sleep] WARNING: ADMIN_USER_ID is not set. Admin `/sleep` will be unreachable —',
      'the world can only advance via nightly cron. Set this env var to enable admin tick.',
    );

    process.env.ADMIN_USER_ID = prev;
    warn.mockRestore();
  });
});
