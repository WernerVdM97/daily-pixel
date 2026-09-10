import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  WizardSession,
} from "../../src/controller/WizardSession.js";

describe("WizardSession", () => {
  let session: WizardSession;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new WizardSession(10 * 60 * 1000); // 10 min TTL
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── start ──

  it("starts a new session at step 1", () => {
    const state = session.start("user-1");
    expect(state.step).toBe(1);
    expect(state.discordUserId).toBe("user-1");
    expect(state.startedAt).toBeInstanceOf(Date);
  });

  it("throws when starting a session for a user that already has one", () => {
    session.start("user-1");
    expect(() => session.start("user-1")).toThrow(/already in a wizard/i);
  });

  // ── step 1: name ──

  it("sets name and advances to step 2 (class)", () => {
    session.start("user-1");
    const state = session.setName("user-1", "Aldric");
    expect(state.step).toBe(2);
    expect(state.name).toBe("Aldric");
  });

  it("rejects empty name", () => {
    session.start("user-1");
    expect(() => session.setName("user-1", "")).toThrow(/name must be/i);
  });

  it("rejects name shorter than 2 characters", () => {
    session.start("user-1");
    expect(() => session.setName("user-1", "A")).toThrow(/name must be/i);
  });

  it("rejects name longer than 30 characters", () => {
    session.start("user-1");
    expect(() => session.setName("user-1", "A".repeat(31))).toThrow(
      /name must be/i,
    );
  });

  it("accepts name of exactly 2 characters", () => {
    session.start("user-1");
    const state = session.setName("user-1", "Jo");
    expect(state.step).toBe(2);
    expect(state.name).toBe("Jo");
  });

  it("accepts name of exactly 30 characters", () => {
    session.start("user-1");
    const name = "A".repeat(30);
    const state = session.setName("user-1", name);
    expect(state.step).toBe(2);
  });

  it("rejects names containing Discord user pings (@)", () => {
    session.start("user-1");
    expect(() => session.setName("user-1", "@everyone")).toThrow(
      /name must not contain/i,
    );
  });

  it("rejects names containing Discord channel pings (#)", () => {
    session.start("user-1");
    expect(() => session.setName("user-1", "foo#bar")).toThrow(
      /name must not contain/i,
    );
  });

  it("trims whitespace from name", () => {
    session.start("user-1");
    const state = session.setName("user-1", "  Aldric  ");
    expect(state.name).toBe("Aldric");
  });

  // ── steps 2-6: choose ──

  it("advances class choice (step 2 → 3)", () => {
    session.start("user-1");
    session.setName("user-1", "Aldric");
    const state = session.choose("user-1", 2, "class", "Warrior");
    expect(state.step).toBe(3);
    expect(state.class).toBe("Warrior");
  });

  it("advances upbringing choice (step 3 → 4)", () => {
    session.start("user-1");
    session.setName("user-1", "Aldric");
    session.choose("user-1", 2, "class", "Warrior");
    const state = session.choose("user-1", 3, "upbringing", "Soldier");
    expect(state.step).toBe(4);
    expect(state.upbringing).toBe("Soldier");
  });

  it("advances race choice (step 4 → 5)", () => {
    session.start("user-1");
    session.setName("user-1", "Aldric");
    session.choose("user-1", 2, "class", "Warrior");
    session.choose("user-1", 3, "upbringing", "Soldier");
    const state = session.choose("user-1", 4, "race", "Human");
    expect(state.step).toBe(5);
    expect(state.race).toBe("Human");
  });

  it("advances alignment choice (step 5 → 6)", () => {
    session.start("user-1");
    session.setName("user-1", "Aldric");
    session.choose("user-1", 2, "class", "Warrior");
    session.choose("user-1", 3, "upbringing", "Soldier");
    session.choose("user-1", 4, "race", "Human");
    const state = session.choose("user-1", 5, "alignment", "lawful good");
    expect(state.step).toBe(6);
    expect(state.alignment).toBe("lawful good");
  });

  it("advances day-job choice (step 6 → 7)", () => {
    session.start("user-1");
    session.setName("user-1", "Aldric");
    session.choose("user-1", 2, "class", "Warrior");
    session.choose("user-1", 3, "upbringing", "Soldier");
    session.choose("user-1", 4, "race", "Human");
    session.choose("user-1", 5, "alignment", "lawful good");
    const state = session.choose("user-1", 6, "dayJob", "Blacksmith");
    expect(state.step).toBe(7);
    expect(state.dayJob).toBe("Blacksmith");
  });

  it("advances itemSet choice (step 7 → 8 confirm)", () => {
    session.start("user-1");
    session.setName("user-1", "Aldric");
    session.choose("user-1", 2, "class", "Warrior");
    session.choose("user-1", 3, "upbringing", "Soldier");
    session.choose("user-1", 4, "race", "Human");
    session.choose("user-1", 5, "alignment", "lawful good");
    session.choose("user-1", 6, "dayJob", "Blacksmith");
    const state = session.choose("user-1", 7, "itemSet", "Soldier's Kit");
    expect(state.step).toBe(8);
    expect(state.itemSet).toBe("Soldier's Kit");
  });

  it("throws when choosing at wrong step", () => {
    session.start("user-1");
    expect(() => session.choose("user-1", 2, "class", "Warrior")).toThrow(
      /step 1/i,
    );
  });

  it("throws choosing for unknown user", () => {
    expect(() => session.choose("no-one", 2, "class", "Warrior")).toThrow(
      /no wizard session/i,
    );
  });

  // ── confirm / reset ──

  it("confirm returns CharCreateData and clears the session", () => {
    session.start("user-1");
    session.setName("user-1", "Aldric");
    session.choose("user-1", 2, "class", "Warrior");
    session.choose("user-1", 3, "upbringing", "Soldier");
    session.choose("user-1", 4, "race", "Human");
    session.choose("user-1", 5, "alignment", "lawful good");
    session.choose("user-1", 6, "dayJob", "Blacksmith");
    session.choose("user-1", 7, "itemSet", "Soldier's Kit");

    const data = session.confirm("user-1");
    expect(data).toEqual({
      name: "Aldric",
      class: "Warrior",
      upbringing: "Soldier",
      race: "Human",
      alignment: "lawful good",
      dayJob: "Blacksmith",
      itemSetName: "Soldier's Kit",
    });

    // session cleared
    expect(session.getSession("user-1")).toBeUndefined();
  });

  it("confirm throws if not at step 8", () => {
    session.start("user-1");
    expect(() => session.confirm("user-1")).toThrow(/step 8/i);
  });

  it("reset clears the session", () => {
    session.start("user-1");
    session.reset("user-1");
    expect(session.getSession("user-1")).toBeUndefined();
  });

  it("reset is safe for unknown users", () => {
    expect(() => session.reset("no-one")).not.toThrow();
  });

  // ── expiry ──

  it("isExpired returns false for fresh session", () => {
    session.start("user-1");
    expect(session.isExpired("user-1")).toBe(false);
  });

  it("isExpired returns true after TTL", () => {
    session.start("user-1");
    vi.advanceTimersByTime(11 * 60 * 1000); // 11 minutes
    expect(session.isExpired("user-1")).toBe(true);
  });

  it("isExpired returns false for unknown user", () => {
    expect(session.isExpired("no-one")).toBe(false);
  });

  // ── getSession ──

  it("returns undefined for unknown user", () => {
    expect(session.getSession("no-one")).toBeUndefined();
  });

  it("returns full state snapshot", () => {
    session.start("user-1");
    session.setName("user-1", "Aldric");
    session.choose("user-1", 2, "class", "Warrior");

    const state = session.getSession("user-1")!;
    expect(state.step).toBe(3);
    expect(state.name).toBe("Aldric");
    expect(state.class).toBe("Warrior");
    expect(state.upbringing).toBeUndefined();
    expect(state.startedAt).toBeInstanceOf(Date);
  });
});
