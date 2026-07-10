import { describe, it, expect } from "vitest";
import { buildActionHints } from "../../src/discord/commands/action.js";

/**
 * `/action` hints — pure hint-builder shared by the slash path (action.ts)
 * and the `nav:action` button path (index.ts) so the two menus can't drift.
 */
describe("buildActionHints", () => {
  it("returns no hints when nothing applies", () => {
    const hints = buildActionHints({
      rollsRemaining: 3,
      stamina: 10,
      maxStamina: 10,
      isSafe: true,
    });
    expect(hints).toEqual([]);
  });

  it("flags the last action of the day when exactly one roll remains", () => {
    const hints = buildActionHints({
      rollsRemaining: 1,
      stamina: 10,
      maxStamina: 10,
      isSafe: true,
    });
    expect(hints).toEqual(["🎲 Last action of the day — make it count."]);
  });

  it("does not flag rolls remaining when more than one is left", () => {
    const hints = buildActionHints({
      rollsRemaining: 2,
      stamina: 10,
      maxStamina: 10,
      isSafe: true,
    });
    expect(hints).toEqual([]);
  });

  it("flags low stamina at the 25% threshold", () => {
    const hints = buildActionHints({
      rollsRemaining: 3,
      stamina: 2,
      maxStamina: 10,
      isSafe: true,
    });
    expect(hints).toEqual(["😮‍💨 You're running on fumes (2/10 stamina)."]);
  });

  it("does not flag stamina just above the 25% threshold", () => {
    // Threshold for maxStamina 10 is round(10 * 0.25) = 3, so 4 is the first safe value.
    const hints = buildActionHints({
      rollsRemaining: 3,
      stamina: 4,
      maxStamina: 10,
      isSafe: true,
    });
    expect(hints).toEqual([]);
  });

  it("floors the low-stamina threshold at 2, even for a small max stamina", () => {
    // 25% of 4 rounds to 1, but the floor of 2 still catches this as running low.
    const hints = buildActionHints({
      rollsRemaining: 3,
      stamina: 2,
      maxStamina: 4,
      isSafe: true,
    });
    expect(hints).toEqual(["😮‍💨 You're running on fumes (2/4 stamina)."]);
  });

  it("flags an unsafe location", () => {
    const hints = buildActionHints({
      rollsRemaining: 3,
      stamina: 10,
      maxStamina: 10,
      isSafe: false,
    });
    expect(hints).toEqual(["⚠️ This place isn't safe — trouble may find you."]);
  });

  it("stacks all three hints, in order, when every condition holds", () => {
    const hints = buildActionHints({
      rollsRemaining: 1,
      stamina: 1,
      maxStamina: 10,
      isSafe: false,
    });
    expect(hints).toEqual([
      "🎲 Last action of the day — make it count.",
      "😮‍💨 You're running on fumes (1/10 stamina).",
      "⚠️ This place isn't safe — trouble may find you.",
    ]);
  });

  it("stacks a subset when only some conditions hold", () => {
    const hints = buildActionHints({
      rollsRemaining: 1,
      stamina: 10,
      maxStamina: 10,
      isSafe: false,
    });
    expect(hints).toEqual([
      "🎲 Last action of the day — make it count.",
      "⚠️ This place isn't safe — trouble may find you.",
    ]);
  });
});
