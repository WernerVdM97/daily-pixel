import { describe, it, expect } from "vitest";
import { makeHelpCommand } from "../../src/discord/commands/help.js";

describe("/help", () => {
  it("returns a command list", async () => {
    const handler = makeHelpCommand();
    const result = await handler({} as never);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
  });

  it("mentions all deterministic commands", async () => {
    const handler = makeHelpCommand();
    const result = await handler({} as never);

    expect(result).toContain("/join");
    expect(result).toContain("/stats");
    expect(result).toContain("/backpack");
    expect(result).toContain("/look");
    expect(result).toContain("/journal");
    expect(result).toContain("/help");
    expect(result).toContain("/feedback");
    expect(result).toContain("/bug");
    expect(result).toContain("/hi");
  });

  it("explains roll economy", async () => {
    const handler = makeHelpCommand();
    const result = await handler({} as never);

    expect(result.toLowerCase()).toContain("roll");
    expect(result.toLowerCase()).toContain("refresh");
  });

  it("explains action types", async () => {
    const handler = makeHelpCommand();
    const result = await handler({} as never);

    expect(result.toLowerCase()).toContain("action");
  });
});
