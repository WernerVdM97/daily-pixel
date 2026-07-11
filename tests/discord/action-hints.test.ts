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

  // N3: on Saturday the allowance is 4 (base 3 + bonus), so the genuine last roll is still
  // reached at rollsRemaining === 1. The hint must NOT fire a roll early (at 2, with the bonus
  // roll still in hand) and MUST fire on that true final roll — the hint keys off rolls left,
  // which is allowance-agnostic, so no premature Saturday warning.
  it("does not flag the last action a roll early on Saturday, with the bonus roll still in hand", () => {
    const hints = buildActionHints({
      rollsRemaining: 2, // 2 of Saturday's 4-roll allowance left — not the last action yet
      stamina: 10,
      maxStamina: 10,
      isSafe: true,
    });
    expect(hints).toEqual([]);
  });

  it("flags the genuine last Saturday roll (one of the 4-roll allowance remaining)", () => {
    const hints = buildActionHints({
      rollsRemaining: 1,
      stamina: 10,
      maxStamina: 10,
      isSafe: true,
    });
    expect(hints).toEqual(["🎲 Last action of the day — make it count."]);
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

  it("does not flag a 1/1 character at full stamina, despite being under the floor threshold", () => {
    const hints = buildActionHints({
      rollsRemaining: 3,
      stamina: 1,
      maxStamina: 1,
      isSafe: true,
    });
    expect(hints).toEqual([]);
  });

  it("does not flag a 2/2 character at full stamina, despite being under the floor threshold", () => {
    const hints = buildActionHints({
      rollsRemaining: 3,
      stamina: 2,
      maxStamina: 2,
      isSafe: true,
    });
    expect(hints).toEqual([]);
  });

  it("still flags a character below full stamina even when max stamina is tiny", () => {
    const hints = buildActionHints({
      rollsRemaining: 3,
      stamina: 1,
      maxStamina: 2,
      isSafe: true,
    });
    expect(hints).toEqual(["😮‍💨 You're running on fumes (1/2 stamina)."]);
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
