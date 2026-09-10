import { describe, it, expect, afterEach, vi } from "vitest";
import { collapseNotice, announceCollapse, setCollapseBroadcaster } from "../../src/discord/collapse.js";
import { GameRouter, type RouterBackend } from "../../src/protocol/router.js";
import { SessionController } from "../../src/controller/SessionController.js";
import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import type { ActionOutcome, ActionStartResult, CharacterData } from "../../src/engine/WorldEngine.js";
import { WizardSession } from "../../src/controller/WizardSession.js";
import type { CharDefs } from "../../src/controller/joinWizard.js";

describe("collapseNotice", () => {
  it("fires on a health transition to 0, naming the character", () => {
    const notice = collapseNotice("Aldric", { health: 3, stamina: 5 }, { health: 0, stamina: 5 });
    expect(notice).toContain("Aldric");
    expect(notice).toContain("collapsed");
    expect(notice).not.toContain("spent");
  });

  it("fires on a stamina transition to 0", () => {
    const notice = collapseNotice("Bram", { health: 5, stamina: 2 }, { health: 5, stamina: 0 });
    expect(notice).toContain("Bram");
    expect(notice).toContain("spent");
    expect(notice).not.toContain("collapsed");
  });

  it("fires both when health and stamina bottom out together", () => {
    const notice = collapseNotice("Kara", { health: 1, stamina: 1 }, { health: 0, stamina: 0 });
    expect(notice).toContain("collapsed");
    expect(notice).toContain("spent");
  });

  it("does not fire when already at 0 (no transition)", () => {
    expect(collapseNotice("Aldric", { health: 0, stamina: 0 }, { health: 0, stamina: 0 })).toBeNull();
  });

  it("does not fire when vitals stay above 0", () => {
    expect(collapseNotice("Aldric", { health: 5, stamina: 5 }, { health: 3, stamina: 4 })).toBeNull();
  });

  it("returns null when either snapshot is missing", () => {
    expect(collapseNotice("Aldric", null, { health: 0, stamina: 0 })).toBeNull();
    expect(collapseNotice("Aldric", { health: 1, stamina: 1 }, undefined)).toBeNull();
  });
});

// ── M9.1 (review-fix) — the collapse FACT's lossless-mapping proof (DC-M9.2). The prior
// version of this block mirrored src/protocol/router.ts's private `outcomeFacts` construction
// by hand, so both sides of every assertion were f(x) from the SAME local mirror — it could
// never fail if the router's real fact were short a field, carried the wrong `name`, or
// swapped `prev`/`updated`. This version sources `fact` from a REAL GameRouter outcome
// envelope (real SessionController + MockWorldEngine, the contract-test wiring — see
// tests/protocol/contract.test.ts:357-366), and feeds it into the real, unmodified
// `announceCollapse`, so a router regression actually breaks the test. This stands in for the
// real consumer (dispatchInteraction.ts's three announceCollapse call sites), which doesn't
// land until M9.3. ──

const USER = 'user-1';
const IDLE = 'The wind stirs the leaves.';
const SCENE = 'A quiet clearing under the oak.';

const EMPTY_DEFS: CharDefs = { classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [] };

const RESOLVED_OUTCOME: ActionOutcome = {
  distilledType: 'scout',
  finalDc: 11,
  playerRolled: 14,
  outcome: 'success',
  rollBonus: 3,
  rollStat: 'physical',
  mutations: [{ type: 'modify_stamina', amount: -1 }],
  outcomeText: 'You crest the ridge and chart the valley below.',
  actionId: 77,
};

const START_RESULT: ActionStartResult = {
  state: { rawInput: 'scout the ridge', decisions: [], accumulatedDc: 11, kind: 'quest' },
  firstDecision: { prompt: '', options: [] },
  outcome: RESOLVED_OUTCOME,
  actionType: 'search',
};

/** A real GameRouter over a real SessionController + MockWorldEngine (the contract-test
 *  wiring). `getCharacter`/`startAction` are spied so a read BEFORE `startAction` and a read
 *  AFTER it return genuinely distinct snapshots — matching what
 *  SessionController.renderStartResult actually does (src/controller/SessionController.ts:557+:
 *  `prevChar` is the pre-action read, `char` a fresh post-action read). A scripted
 *  `mockReturnValueOnce` chain on `getCharacter` would be brittle here — `addCharacterFacts`
 *  performs a further read after the outcome read — so instead the current character lives in
 *  a mutable variable that `getCharacter` always returns, and `startAction` flips it to the
 *  post snapshot before resolving. Every read before the flip yields `prevChar`; every read
 *  after yields `char`, regardless of how many reads occur. */
function routerWithTransition(prevChar: CharacterData, char: CharacterData): GameRouter {
  const engine = new MockWorldEngine();
  let current = prevChar;
  vi.spyOn(engine, 'getCharacter').mockImplementation(() => current);
  vi.spyOn(engine, 'startAction').mockImplementation(async () => {
    current = char;
    return START_RESULT;
  });
  const backend: RouterBackend = new SessionController(
    engine,
    () => SCENE,
    [],
    undefined,
    new WizardSession(),
    EMPTY_DEFS,
    () => ({ sceneName: 'test', ascii: '...' }),
  );
  return new GameRouter(backend, { idle: () => IDLE });
}

describe("collapse fact (DC-M9.2) — lossless-mapping proof (M9.1)", () => {
  afterEach(() => {
    setCollapseBroadcaster(null);
  });

  const TRANSITIONS: Array<{
    label: string;
    prevChar: CharacterData;
    char: CharacterData;
  }> = [
    {
      label: "health crosses to 0",
      prevChar: MockWorldEngine.defaultCharacter({ name: "Aldric", health: 3, stamina: 5 }),
      char: MockWorldEngine.defaultCharacter({ name: "Aldric", health: 0, stamina: 5 }),
    },
    {
      label: "stamina crosses to 0",
      prevChar: MockWorldEngine.defaultCharacter({ name: "Bram", health: 5, stamina: 2 }),
      char: MockWorldEngine.defaultCharacter({ name: "Bram", health: 5, stamina: 0 }),
    },
    {
      label: "both cross to 0 together",
      prevChar: MockWorldEngine.defaultCharacter({ name: "Kara", health: 1, stamina: 1 }),
      char: MockWorldEngine.defaultCharacter({ name: "Kara", health: 0, stamina: 0 }),
    },
    {
      label: "neither crosses",
      prevChar: MockWorldEngine.defaultCharacter({ name: "Aldric", health: 5, stamina: 5 }),
      char: MockWorldEngine.defaultCharacter({ name: "Aldric", health: 3, stamina: 4 }),
    },
    {
      label: "already at 0 before (no transition)",
      prevChar: MockWorldEngine.defaultCharacter({ name: "Aldric", health: 0, stamina: 0 }),
      char: MockWorldEngine.defaultCharacter({ name: "Aldric", health: 0, stamina: 0 }),
    },
  ];

  for (const { label, prevChar, char } of TRANSITIONS) {
    it(`${label}: announceCollapse fed from the router's real collapse fact delivers the identical string as announceCollapse fed from the two fixtures it was built from`, async () => {
      const router = routerWithTransition(prevChar, char);

      const response = await router.dispatch({ type: 'action.custom', playerId: USER, text: 'scout the ridge' });
      expect(response.ok).toBe(true);
      if (!response.ok) return;

      const fact = response.facts?.collapse as
        | { name: string; prev: { health: number; stamina: number }; updated: { health: number; stamina: number } }
        | undefined;
      expect(fact).toBeDefined();

      const fromFact: string[] = [];
      setCollapseBroadcaster((content) => { fromFact.push(content); });
      await announceCollapse(fact!.name, fact!.prev, fact!.updated);

      const fromFixtures: string[] = [];
      setCollapseBroadcaster((content) => { fromFixtures.push(content); });
      await announceCollapse(char.name, prevChar, char);

      expect(fromFact).toEqual(fromFixtures);
    });
  }
});
