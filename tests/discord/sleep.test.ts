import { describe, it, expect } from "vitest";
import { makeSleepCommand } from "../../src/discord/commands/sleep.js";

import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";

// Set up admin user ID before importing the sleep command
const ADMIN_ID = 'admin-123';
process.env.ADMIN_USER_ID = ADMIN_ID;

describe("/sleep", () => {
  it("returns rest scene for non-admin user", async () => {
    const engine = new MockWorldEngine();
    const handler = makeSleepCommand(engine);
    const result = await handler({
      user: { id: 'non-admin-user' },
    });

    expect(result).toContain("bank the fire");
    expect(result).toContain("Oak");
    expect(result).toContain("day turns when the world wills it");
    expect(result).not.toContain("Day");
    expect(result).not.toContain("begins");
  });

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
});
