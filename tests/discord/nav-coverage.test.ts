import { describe, it, expect } from "vitest";

import { CommandRegistry, type NavFacts } from "../../src/discord/CommandRegistry.js";
import { makeHarness, oracleChar, slashInteraction } from "./dispatch-harness.js";

/**
 * DC-M9.4.6 — the registry-level nav-drop check. `CommandHandler`'s `onNav` is an OPTIONAL
 * second parameter (DC-M9.6): a handler that never calls it is still assignable to the type,
 * so nothing here or in the compiler catches a command that silently drops its nav bar. This
 * suite enumerates EVERY registered command (via `commandNames()`, never a hardcoded list —
 * the failure class is a command registered LATER) and asserts a boolean per DC-M9.4.6: were
 * nav facts supplied, nothing more. No nav shape, no payload, no ack sequence — that would
 * pin a snapshot this slice's zero-churn promise forbids.
 */

/** Per-command slash-option payloads the fixed interaction needs to reach a normal reply
 *  (feedback/bug read a required `text` option); every other command ignores extra options. */
const STRING_OPTS: Record<string, Record<string, string>> = {
  feedback: { text: "test feedback" },
  bug: { text: "test bug report" },
};

/**
 * Runs every name in `registry.commandNames()` through its own handler with a character
 * present, and reports which ones never handed nav facts back through `onNav`. A handler
 * that throws counts as a MISS, not a silent pass — an exception must not be mistaken for
 * "supplied nav" any more than a handler that never calls `onNav` at all. `checked` is
 * returned alongside `missing` so a caller can prove the loop actually walked the full
 * registry rather than an empty or short one.
 */
async function findNavCoverage(
  registry: CommandRegistry,
  buildInteraction: (name: string) => unknown,
): Promise<{ checked: string[]; missing: string[] }> {
  const checked: string[] = [];
  const missing: string[] = [];

  for (const name of registry.commandNames()) {
    checked.push(name);
    const handler = registry.get(name);
    if (!handler) {
      missing.push(name);
      continue;
    }

    let navCalled = false;
    let nav: NavFacts | undefined;
    try {
      await handler(buildInteraction(name), (n) => {
        navCalled = true;
        nav = n;
      });
    } catch {
      missing.push(name);
      continue;
    }

    if (!navCalled || nav === undefined) missing.push(name);
  }

  return { checked, missing };
}

describe("registry-level nav coverage (DC-M9.4.6)", () => {
  it("proves the check is non-vacuous: a deliberately non-forwarding handler is caught", async () => {
    // The exact hazard DC-M9.4.6 names: `async () => "x"` takes no second parameter and is
    // still assignable to `CommandHandler`, because `onNav` is optional. This registry is
    // real proof the check would fail loudly on a command like this, run on every CI run —
    // not a one-off tamper recorded only in a commit message.
    const brokenRegistry = new CommandRegistry();
    brokenRegistry.register("broken", async () => "x");
    brokenRegistry.register("also-broken", async () => "y");

    const { checked, missing } = await findNavCoverage(brokenRegistry, () => ({
      user: { id: "tamper-1" },
    }));

    expect(checked).toEqual(["broken", "also-broken"]);
    expect(missing).toEqual(["broken", "also-broken"]);
  });

  it("proves the check passes a handler that DOES forward nav", async () => {
    const okRegistry = new CommandRegistry();
    okRegistry.register("forwards", async (_interaction, onNav) => {
      onNav?.({ rollsRemaining: 3, hasPendingAction: false, hasRestedToday: false });
      return "ok";
    });

    const { checked, missing } = await findNavCoverage(okRegistry, () => ({
      user: { id: "tamper-2" },
    }));

    expect(checked).toEqual(["forwards"]);
    expect(missing).toEqual([]);
  });

  it("every registered command either supplies nav facts or is on the explicit allow-list", async () => {
    const h = makeHarness();
    h.engine.setCharacterExists(true);
    h.engine.setCharacter(oracleChar());

    const { checked, missing } = await findNavCoverage(h.deps.registry, (name) =>
      slashInteraction("nav-coverage-user", name, STRING_OPTS[name] ?? {}).intr,
    );

    // Non-vacuity for the real registry: prove the loop actually walked all 13 production
    // commands (src/index.ts's 13 registry.register(...) calls), not an empty or truncated
    // list — a silently-short enumeration would let a later-registered command slip past.
    expect(checked.length).toBe(13);
    expect(new Set(checked)).toEqual(
      new Set([
        "ping",
        "help",
        "stats",
        "backpack",
        "look",
        "journal",
        "map",
        "feedback",
        "bug",
        "sleep",
        "hi",
        "join",
        "action",
      ]),
    );

    // Allow-list — each entry verified empirically (not assumed), see the executor report:
    const ALLOWED_NO_NAV = new Set([
      // Runs the 7-step character-creation wizard. With a character already present (the
      // scenario every other command is checked under) `join.open` takes the has-character
      // guard and returns before ever reaching a second `onNav` parameter — the handler's
      // signature (src/discord/commands/join.ts) doesn't declare one at all.
      "join",
      // Manages its own nav buttons: the outcome arm reads `facts.nav` directly off the
      // router response and paints `getNavButtons(nav)` inline into its own reply
      // (src/discord/commands/action.ts) rather than handing them back through `onNav`.
      // The dispatcher's generic weld explicitly skips this command for the same reason
      // (src/discord/dispatchInteraction.ts: `if (commandName === "action") // /action
      // manages its own buttons`). The bar is supplied — just not through this channel.
      "action",
    ]);

    const unexplained = missing.filter((name) => !ALLOWED_NO_NAV.has(name));
    expect(unexplained).toEqual([]);

    // The allow-list is exact, not a superset padded against future drift — if a command
    // ever starts supplying nav, its allow-list entry must be removed in the same change.
    expect(new Set(missing)).toEqual(ALLOWED_NO_NAV);
  });
});
