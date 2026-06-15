import { describe, it, expect } from "vitest";
import { makeHelpCommand } from "../../src/discord/commands/help.js";

describe("/help", () => {
  it("returns a command list", async () => {
    const handler = makeHelpCommand();
    const result = await handler();

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
  });

  it("mentions all deterministic commands", async () => {
    const handler = makeHelpCommand();
    const result = await handler();

    expect(result).toContain("/join");
    expect(result).toContain("/stats");
    expect(result).toContain("/backpack");
    expect(result).toContain("/look");
    expect(result).toContain("/journal");
    expect(result).toContain("/help");
    expect(result).toContain("/feedback");
    expect(result).toContain("/bug");
    expect(result).toContain("/hi");
    expect(result).toContain("/sleep");
    expect(result).toContain("/action");
  });

  it("explains roll economy", async () => {
    const handler = makeHelpCommand();
    const result = await handler();

    expect(result.toLowerCase()).toContain("roll");
    expect(result.toLowerCase()).toContain("reset");
    expect(result.toLowerCase()).toContain("/sleep");
    expect(result.toLowerCase()).toContain("skip");
  });

  it("explains action types", async () => {
    const handler = makeHelpCommand();
    const result = await handler();

    expect(result.toLowerCase()).toContain("action");
  });

  it("mentions the rest /sleep command", async () => {
    const handler = makeHelpCommand();
    const result = await handler();

    expect(result).toContain("/sleep");
    expect(result.toLowerCase()).toContain("camp");
    expect(result.toLowerCase()).toContain("oak");
    expect(result.toLowerCase()).toContain("nightfall");
  });

  it("explains the economy section fully", async () => {
    const handler = makeHelpCommand();
    const result = await handler();

    expect(result).toContain("2 rolls per day");
    expect(result).toContain("consumes 1 roll");
    expect(result).toContain("Bail");
    expect(result).toContain("Skip");
  });
});
