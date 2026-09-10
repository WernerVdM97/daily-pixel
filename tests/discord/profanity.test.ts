import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkProfanity, resetCache } from "../../src/protocol/profanity.js";

describe("checkProfanity", () => {
  beforeEach(() => {
    delete process.env.PROFANITY_FILTER;
    resetCache();
  });

  it("returns null when env var is unset", () => {
    expect(checkProfanity("any text at all")).toBeNull();
  });

  it("returns null when env var is empty", () => {
    process.env.PROFANITY_FILTER = "";
    resetCache();
    expect(checkProfanity("any text at all")).toBeNull();
  });

  it("returns null for clean text", () => {
    process.env.PROFANITY_FILTER = "\\bfrack\\b,\\bdarn\\b";
    resetCache();
    expect(checkProfanity("I'm going to the market")).toBeNull();
  });

  it("returns the matched pattern when text is blocked", () => {
    process.env.PROFANITY_FILTER = "\\bfrack\\b";
    resetCache();
    expect(checkProfanity("what the frack")).toBe("frack");
  });

  it("matches against multiple patterns", () => {
    process.env.PROFANITY_FILTER = "\\bfrack\\b,\\bdarn\\b";
    resetCache();
    expect(checkProfanity("darn it all")).toBe("darn");
  });

  it("is case-insensitive", () => {
    process.env.PROFANITY_FILTER = "\\bfrack\\b";
    resetCache();
    expect(checkProfanity("What the FRACK")).toBe("FRACK");
  });

  it("skips invalid regex patterns with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.PROFANITY_FILTER = "\\bfrack\\b,[invalid";
    resetCache();

    expect(checkProfanity("what the frack")).toBe("frack");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipping invalid regex"),
    );
    warn.mockRestore();
  });

  it("matches whole words with \\b boundary", () => {
    process.env.PROFANITY_FILTER = "\\bfrack\\b";
    resetCache();
    expect(checkProfanity("fracking")).toBeNull();
    expect(checkProfanity("frack")).toBe("frack");
  });

  it("handles unicode patterns", () => {
    process.env.PROFANITY_FILTER = "schäbig";
    resetCache();
    expect(checkProfanity("das ist schäbig")).toBe("schäbig");
  });
});
