import { describe, it, expect } from "vitest";

import { SessionController } from "../../src/controller/SessionController.js";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { WizardSession } from "../../src/controller/WizardSession.js";
import type { CharDefs } from "../../src/controller/joinWizard.js";
import type { NoticeViewState } from "../../src/view/viewState.js";

// M8.1 (DC-M8.3/5/7) — the six `open*` screen methods, driven directly (no router): the
// five char-gated screens return `no-character` without a character and the composed
// NoticeViewState with one; `openHelp` has NO guard (help works charless today). The
// no-stamp property is pinned with the engine's own call record (the M7.2 fix's pattern
// applied to the controller surface, not just presence-in-oracle): NO `open*` arm may
// call `updateLastPlayed` — the dispatcher's slash-arm post-handler stamp and the nav
// branch's pre-handler stamp cover both arms, and a stamp here would double-stamp.
const EMPTY_DEFS: CharDefs = { classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [] };
const SCENE_STUB = () => ({ sceneName: "test", ascii: "..." });

function makeController(engine: MockWorldEngine): SessionController {
  return new SessionController(engine, () => "", [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);
}

function withChar(overrides?: Record<string, unknown>): MockWorldEngine {
  const engine = new MockWorldEngine();
  engine.setCharacter(MockWorldEngine.defaultCharacter(overrides as never));
  return engine;
}

const GATED = ["openLook", "openMap", "openStats", "openBackpack", "openJournal"] as const;

describe("SessionController — the five char-gated screens (M8.1, DC-M8.3)", () => {
  for (const method of GATED) {
    it(`${method} → no-character without a character, and NEVER stamps updateLastPlayed`, () => {
      const engine = new MockWorldEngine();
      const controller = makeController(engine);
      const result = controller[method]("no-char") as { kind: string };
      expect(result.kind).toBe("no-character");
      expect(engine.calls.updateLastPlayed).toEqual([]);
      expect(engine.calls.characterExists).toEqual([]); // the screens read, never gate
    });

    it(`${method} → the composed notice view with a character, and NEVER stamps updateLastPlayed`, () => {
      const engine = withChar();
      const controller = makeController(engine);
      const result = controller[method]("user-1") as { kind: string; view: NoticeViewState };
      expect(result.kind).toBe("view");
      expect(result.view.screen).toBe("notice");
      expect(result.view.text.length).toBeGreaterThan(0);
      expect(result.view.ephemeral).toBe(true); // informational — the dispatcher owns the paint until M9
      expect(engine.calls.updateLastPlayed).toEqual([]);
    });
  }

  it("openLook — the composed scene rides the controller's resolveScene dep (DC-M8.5)", () => {
    const engine = withChar({ location: "The Warden's Oak" });
    engine.setLocation({ name: "The Warden's Oak", description: "A massive ancient oak.", tags: ["oak"], isSafe: true, emoji: "🌳" });
    engine.setExits({
      neighbours: [{ name: "Town Square", direction: "N", difficulty: 1 }],
      frontiers: [{ direction: "E", teaser: "a thin trail climbs into the pines", difficulty: 2 }],
    });
    const controller = makeController(engine);
    const result = controller.openLook("user-1") as { kind: string; view: NoticeViewState };
    expect(result.kind).toBe("view");
    expect(result.view.text).toContain("```\n...\n```"); // the harness-style fixed stub
    expect(result.view.text).toContain("🌳 **The Warden's Oak**");
    expect(result.view.text).toContain("**🧭 Paths**");
    expect(engine.calls.getExits).toEqual(["The Warden's Oak"]); // M8.1 residual: log-proven now
  });

  it("openLook — the null-location branch returns the warden's-sight copy before any scene render", () => {
    const engine = withChar({ location: "Nowhere" });
    engine.setLocation(null);
    const controller = makeController(engine);
    const result = controller.openLook("user-1") as { kind: string; view: NoticeViewState };
    expect(result.kind).toBe("view");
    expect(result.view.text).toContain("lost to the warden's sight");
    expect(engine.calls.getExits).toEqual([]);
    expect(engine.calls.getNearbyEntities).toEqual([]);
  });

  it("openMap — forwards the optional focus to the composer; the engine read is getDiscoveredGraph", () => {
    const engine = withChar();
    const controller = makeController(engine);
    const full = controller.openMap("user-1") as { kind: string; view: NoticeViewState };
    const drilled = controller.openMap("user-1", "The Vale") as { kind: string; view: NoticeViewState };
    expect(full.kind).toBe("view");
    expect(drilled.kind).toBe("view");
    expect(engine.calls.getDiscoveredGraph).toEqual([1, 1]); // both arms read the graph once
  });
});

describe("SessionController — openHelp (M8.1, DC-M8.3: NO character guard)", () => {
  it("returns the notice view charless — the no-gate pin — and NEVER stamps updateLastPlayed", () => {
    const engine = new MockWorldEngine();
    const controller = makeController(engine);
    const result = controller.openHelp("no-char");
    expect(result.kind).toBe("view");
    expect(result.view.screen).toBe("notice");
    expect(result.view.text).toContain("Command List");
    expect(result.view.text).toContain("Economy");
    expect(engine.calls.updateLastPlayed).toEqual([]);
    expect(engine.calls.getCharacter).toEqual([]); // help performs NO engine read at all
  });

  it("returns the SAME text with a character (help never branches on the player)", () => {
    const engine = withChar();
    const controller = makeController(engine);
    const charless = makeController(new MockWorldEngine()).openHelp("no-char");
    const withPlayer = controller.openHelp("user-1");
    expect(withPlayer.view.text).toBe(charless.view.text);
    expect(engine.calls.updateLastPlayed).toEqual([]);
  });
});
