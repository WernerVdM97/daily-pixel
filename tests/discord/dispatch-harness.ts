import { vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { SessionController } from "../../src/controller/SessionController.js";
import { WizardSession } from "../../src/controller/WizardSession.js";
import { CommandRegistry, type CommandHandler, type NavFacts } from "../../src/discord/CommandRegistry.js";
import { withEngineNav } from "../../src/discord/navSupply.js";
import { loadYamlFile } from "../../src/assets/yaml-loader.js";
import type { DispatchDeps } from "../../src/discord/dispatchInteraction.js";
import type { DayJobDef } from "../../src/controller/dayJob.js";
import type { CharDefs } from "../../src/controller/joinWizard.js";

import { makeHelpCommand } from "../../src/discord/commands/help.js";
import { makeStatsCommand } from "../../src/discord/commands/stats.js";
import { makeBackpackCommand } from "../../src/discord/commands/backpack.js";
import { makeLookCommand } from "../../src/discord/commands/look.js";
import { makeJournalCommand } from "../../src/discord/commands/journal.js";
import { makeMapCommand } from "../../src/discord/commands/map.js";
import { makeFeedbackCommand } from "../../src/discord/commands/feedback.js";
import { makeBugCommand } from "../../src/discord/commands/bug.js";
import { makeSleepCommand } from "../../src/discord/commands/sleep.js";
import { makeHiCommand } from "../../src/discord/commands/hi.js";
import { makeJoinCommand } from "../../src/discord/commands/join.js";
import { makeActionCommand } from "../../src/discord/commands/action.js";
import { GameRouter } from "../../src/protocol/router.js";
import { randomIdleMessage } from "../../src/engine/IdleMessageSelector.js";

/**
 * Faithful `DispatchDeps` construction for the golden-transcript oracle — mirrors
 * `main()`'s wiring in `src/index.ts` so the real slash arm, `nav:` bar and
 * `action:*` branches drive real command handlers. Test code only.
 */

// ── Real char-creation assets (same files main() loads) ──
// day-jobs.yml gives the day-job branches a real DayJobDef[]; the full CharDefs
// feeds the real /join handler used by the character-gate reroute.
const CC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "char-creation",
);
function load<T>(file: string): T[] {
  return loadYamlFile(path.join(CC_DIR, file)) as T[];
}

export const DAY_JOBS = load<DayJobDef>("day-jobs.yml");

export const CHAR_DEFS: CharDefs = {
  classes: load("classes.yml"),
  backgrounds: load("backgrounds.yml"),
  races: load("races.yml"),
  alignments: load("alignments.yml"),
  dayJobs: DAY_JOBS as never,
  itemSets: load("item-sets.yml"),
};

/** The real character-gated command set (copied from src/index.ts). */
export const CHARACTER_GATED_COMMANDS = new Set([
  "hi",
  "look",
  "action",
  "stats",
  "backpack",
  "journal",
  "map",
  "sleep",
]);

/** A test character on a real class + day job, so the seeded emoji registry resolves real glyphs. */
export function oracleChar(overrides?: Record<string, unknown>) {
  return MockWorldEngine.defaultCharacter({
    id: 1,
    class: "Warrior",
    dayJob: "Town Guard",
    location: "The Warden's Oak",
    rollsRemaining: 3,
    lastActionState: null,
    ...overrides,
  } as never);
}

// ── Registry — mirrors main()'s registry.register(...) wiring, with two deliberate
// test stubs where a stable value beats the live collaborator:
//   • the `look` scene-renderer (~below) is stubbed (`() => ({ sceneName, ascii })`)
//     rather than resolving real tags→scene — a DELIBERATE determinism choice for
//     the screens oracle (M8.0): the golden transcripts pin the code-block wrapper
//     and the surrounding scene, not real art, so the snapshots never depend on the
//     tag→scene catalog. Not a coverage gap. Since M8.1 (DC-M8.5) the stub lives at
//     the SessionController construction site in makeHarness (the controller's 7th
//     param, `resolveScene`) — the registry's look handler is now makeLookCommand(router),
//     and openLook feeds the same fixed stub to the composer.
//   • `getCurrentScene` (passed into the action command) is a FIXED realistic scene
//     string (see makeHarness) rather than main()'s live tag→scene resolution — the
//     only path that reaches it is the outcome render, and a stable value is all the
//     golden transcripts need there.
// Everything else registers exactly as main() does.

const asHandler = (fn: unknown): CommandHandler => fn as CommandHandler;

/** Adapts a `{ user, text }` handler to a slash command (as index.ts's withTextOption). */
function withTextOption(
  fn: (
    i: { user: { id: string }; text: string },
    onNav?: (nav: NavFacts | undefined) => void,
  ) => Promise<string>,
): CommandHandler {
  return async (interaction: unknown, onNav) => {
    const cmd = interaction as {
      user: { id: string };
      options: { getString: (n: string, req?: boolean) => string };
    };
    const text = cmd.options.getString("text", true);
    return fn({ user: { id: cmd.user.id }, text }, onNav);
  };
}

export function buildRegistry(
  engine: MockWorldEngine,
  _joinWizards: WizardSession,
  _getCurrentScene: (userId: string) => string,
  router: GameRouter,
): CommandRegistry {
  const registry = new CommandRegistry();

  // The SAME wrapper index.ts registers (DC-M9.6), imported rather than copied — so the
  // /ping transcripts exercise production wiring, not a look-alike.
  registry.register(
    "ping",
    withEngineNav(engine, asHandler(async () => "pong")),
  );
  registry.register("help", asHandler(makeHelpCommand(router)));
  registry.register("stats", asHandler(makeStatsCommand(router)));
  registry.register("backpack", asHandler(makeBackpackCommand(router)));
  registry.register("look", asHandler(makeLookCommand(router)));
  registry.register("journal", asHandler(makeJournalCommand(router)));
  const mapCommand = makeMapCommand(router);
  registry.register("map", async (interaction: unknown, onNav) => {
    const cmd = interaction as {
      user: { id: string };
      options?: { getString?: (n: string) => string | null };
    };
    const focus =
      typeof cmd.options?.getString === "function"
        ? cmd.options.getString("place") ?? undefined
        : undefined;
    return mapCommand({ user: { id: cmd.user.id }, focus }, onNav);
  });
  registry.register("feedback", withTextOption(makeFeedbackCommand(router)));
  registry.register("bug", withTextOption(makeBugCommand(router)));
  registry.register("sleep", asHandler(makeSleepCommand(engine, router)));
  registry.register("hi", asHandler(makeHiCommand(router)));
  registry.register(
    "join",
    asHandler(makeJoinCommand(router)),
  );
  registry.register(
    "action",
    asHandler(makeActionCommand(router, engine)),
  );

  return registry;
}

export interface Harness {
  engine: MockWorldEngine;
  joinWizards: WizardSession;
  deps: DispatchDeps;
  notifyAdmin: ReturnType<typeof vi.fn>;
  safeErrorReply: ReturnType<typeof vi.fn>;
}

/**
 * A fresh engine + wizard + registry + deps. Every transcript builds its own so
 * the four module-level flow maps (`pendingDecisions`, `_menuMessages`,
 * `_sceneLookup`, `_userInFlight`) never bleed across tests — combined with the
 * unique-userId rule (they have no clear-all).
 */
export function makeHarness(): Harness {
  const engine = new MockWorldEngine();
  const joinWizards = new WizardSession();
  // Fixed, non-empty scene: the outcome render (the only path that reads this) now
  // reaches it, so it must be a stable realistic value rather than "" for the golden
  // snapshots to be honest and deterministic.
  const getCurrentScene = (): string => "A quiet clearing under the oak.";
  // M8.1 (DC-M8.5 + the M8.0→M8.1 coordinator obligation): the controller's 7th constructor
  // dep is the FIXED scene-renderer stub — NOT the real tag→scene resolver — so the screens
  // oracle's look transcripts stay deterministic (the code-block wrapper + surrounding scene
  // are what the golden transcripts pin, never real art). Survives M8.1 or transcripts 1/3
  // churn beyond the planned five charless-nav snapshots.
  const controller = new SessionController(engine, getCurrentScene, DAY_JOBS, CHARACTER_GATED_COMMANDS, joinWizards, CHAR_DEFS, () => ({ sceneName: "test", ascii: "..." }));
  // M7.1 (DC-M7.1.7): a GameRouter over the real controller (the same wiring main() uses).
  // M9.2: idle is wired to the REAL randomIdleMessage (matching index.ts's own
  // `{ idle: () => randomIdleMessage() }` exactly) rather than a fixed empty string — until
  // the slash /action port, no dispatchInteraction-driven flow ever reached a router-level
  // beat (dayjob.start/action.custom/action.choose all still call the controller directly
  // from dispatchInteraction.ts), so the fixed `() => ""` had no observable effect. The
  // slash `/action <text>` arm is the first to fire a router beat through this harness, and
  // action-oracle.test.ts's IdleMessageSelector mock only lands on it if this calls the real
  // (mockable) function — the M7.0 transcripts stay unaffected (no idle-bearing beat there).
  const router = new GameRouter(controller, { idle: () => randomIdleMessage() });
  const registry = buildRegistry(engine, joinWizards, getCurrentScene, router);
  const notifyAdmin = vi.fn(async () => {});
  const safeErrorReply = vi.fn(async () => {});

  const deps: DispatchDeps = {
    engine,
    registry,
    joinWizards,
    controller,
    router,
    idle: () => randomIdleMessage(),
    notifyAdmin,
    safeErrorReply,
    VERBOSE: false,
    ADMIN_USER_ID: "admin-000",
  };

  return { engine, joinWizards, deps, notifyAdmin, safeErrorReply };
}

// ── Fake interactions (plain objects with vi.fn spies, per the existing pattern) ──

export interface Recorded {
  method: string;
  arg: unknown;
}

interface FakeBase {
  /** Ordered log of every ack the dispatcher fired, args normalised for snapshotting. */
  _acks: Recorded[];
}

function recorder() {
  const acks: Recorded[] = [];
  const spy = (method: string, ret?: unknown) =>
    vi.fn(async (...args: unknown[]) => {
      acks.push({ method, arg: args.length === 0 ? null : args[0] });
      return typeof ret === "function" ? (ret as () => unknown)() : ret;
    });
  return { acks, spy };
}

/**
 * Wires `reply`/`deferReply`/`editReply` onto a fake interaction so they enforce
 * discord.js's real ack invariants against its own `replied`/`deferred` flags, instead of
 * recording blindly — the gap that let both M9.2 ack-ordering blockers (an un-acked
 * `editReply`, a lost stale-embed guard) land in a commit with a green suite. `reply` and
 * `deferReply` throw `InteractionAlreadyReplied` if the interaction was already replied or
 * deferred; `editReply` throws `InteractionNotReplied` if neither has happened yet — the
 * exact discord.js error names, so a handler bug surfaces as a thrown error rather than a
 * silently-recorded ack. Shared by all three fake interaction shapes; the component shapes
 * add `deferUpdate`/`update`/`webhook.editMessage` via `wireComponentAcks`.
 */
function wireReplyAcks(intr: Record<string, unknown> & FakeBase, acks: Recorded[]): void {
  intr.reply = vi.fn(async (arg?: unknown) => {
    if (intr.replied || intr.deferred) throw new Error("InteractionAlreadyReplied");
    acks.push({ method: "reply", arg: arg ?? null });
    intr.replied = true;
  });
  intr.deferReply = vi.fn(async (arg?: unknown) => {
    if (intr.replied || intr.deferred) throw new Error("InteractionAlreadyReplied");
    acks.push({ method: "deferReply", arg: arg ?? null });
    intr.deferred = true;
  });
  intr.editReply = vi.fn(async (arg?: unknown) => {
    if (!intr.replied && !intr.deferred) throw new Error("InteractionNotReplied");
    acks.push({ method: "editReply", arg: arg ?? null });
  });
}

/**
 * The component-only ack surface (button + modal-submit), with the same enforce-don't-record
 * discipline `wireReplyAcks` applies (M10.0). `deferUpdate`/`update` mirror discord.js
 * exactly: they flip the same `replied`/`deferred` flags and reject an already-acked
 * interaction, `deferUpdate` behaving like `deferReply` and `update` like `reply`.
 *
 * `webhook.editMessage` is the one that had no invariant at all, which is why the day-job
 * leaf's un-acked catch reached a green suite and got PINNED as correct in the M9.3
 * transcripts. Unlike the others this models a SERVER rejection rather than a discord.js
 * client assertion: discord.js issues the PATCH without complaint, and Discord rejects it
 * because an interaction that was never acked has no response for the followup-webhook token
 * to edit. Two distinct player-visible harms hide behind that, and the fake has to make the
 * first expressible: the edit may not land, and the un-acked interaction shows the player
 * "This interaction failed" once the 3-second window lapses regardless of whether it does.
 */
function wireComponentAcks(intr: Record<string, unknown> & FakeBase, acks: Recorded[]): void {
  intr.deferUpdate = vi.fn(async (arg?: unknown) => {
    if (intr.replied || intr.deferred) throw new Error("InteractionAlreadyReplied");
    acks.push({ method: "deferUpdate", arg: arg ?? null });
    intr.deferred = true;
  });
  intr.update = vi.fn(async (arg?: unknown) => {
    if (intr.replied || intr.deferred) throw new Error("InteractionAlreadyReplied");
    acks.push({ method: "update", arg: arg ?? null });
    intr.replied = true;
  });
  intr.webhook = {
    editMessage: vi.fn(async (_id: string, payload: unknown) => {
      if (!intr.replied && !intr.deferred) {
        throw new Error("Unknown Message (webhook.editMessage on an un-acked interaction)");
      }
      acks.push({ method: "webhook.editMessage", arg: payload });
    }),
  };
}

/** A ChatInputCommand (slash) interaction. `stringOpts` answers options.getString(name). */
export function slashInteraction(
  userId: string,
  commandName: string,
  stringOpts: Record<string, string | null> = {},
): { intr: unknown } & FakeBase {
  const { acks, spy } = recorder();
  const intr: Record<string, unknown> & FakeBase = {
    _acks: acks,
    user: { id: userId, tag: `${userId}#0001` },
    commandName,
    applicationId: "app-1",
    token: "tok-1",
    client: {},
    replied: false,
    deferred: false,
    options: {
      data: [],
      getString: (name: string, _req?: boolean) => stringOpts[name] ?? null,
    },
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
  };
  // reply/deferReply/editReply enforce discord.js's real ack invariants (see wireReplyAcks).
  wireReplyAcks(intr, acks);
  intr.followUp = spy("followUp");
  intr.deleteReply = spy("deleteReply");
  intr.fetchReply = spy("fetchReply", () => ({ id: "msg-1" }));
  return { intr, _acks: acks };
}

/** A button (MessageComponent) interaction. */
export function buttonInteraction(
  userId: string,
  customId: string,
  opts: { v2Ephemeral?: boolean } = {},
): { intr: unknown } & FakeBase {
  const { acks, spy } = recorder();
  const intr: Record<string, unknown> & FakeBase = {
    _acks: acks,
    user: { id: userId, tag: `${userId}#0001` },
    customId,
    applicationId: "app-1",
    token: "tok-1",
    client: {},
    replied: false,
    deferred: false,
    message: {
      id: "msg-1",
      // navResponseMode reads these; v2Ephemeral=true → edit-in-place ('update').
      flags: { has: () => opts.v2Ephemeral ?? false },
    },
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    followUp: spy("followUp"),
    fetchReply: spy("fetchReply", () => ({ id: "msg-1" })),
    showModal: spy("showModal"),
    deleteReply: spy("deleteReply"),
  };
  // Every ack method enforces discord.js's real invariants rather than recording blindly —
  // see wireReplyAcks and wireComponentAcks.
  wireReplyAcks(intr, acks);
  wireComponentAcks(intr, acks);
  return { intr, _acks: acks };
}

/** A modal-submit (MessageComponent) interaction. `field` answers getTextInputValue. */
export function modalInteraction(
  userId: string,
  customId: string,
  field: string,
): { intr: unknown } & FakeBase {
  const { acks, spy } = recorder();
  const intr: Record<string, unknown> & FakeBase = {
    _acks: acks,
    user: { id: userId, tag: `${userId}#0001` },
    customId,
    applicationId: "app-1",
    token: "tok-1",
    client: {},
    replied: false,
    deferred: false,
    message: { id: "msg-1", flags: { has: () => false } },
    fields: { getTextInputValue: () => field },
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    followUp: spy("followUp"),
    fetchReply: spy("fetchReply", () => ({ id: "msg-1" })),
  };
  // Every ack method enforces discord.js's real invariants rather than recording blindly —
  // see wireReplyAcks and wireComponentAcks.
  wireReplyAcks(intr, acks);
  wireComponentAcks(intr, acks);
  return { intr, _acks: acks };
}

/**
 * Deep-normalise a snapshot value: replace binary blobs (image attachment Buffers)
 * with a stable marker so a payload that carries `files: [AttachmentBuilder]` (the
 * /join wizard's Oak thumbnail) snapshots as its filename, not a megabyte of bytes.
 */
function sanitise(value: unknown): unknown {
  if (value == null) return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[binary ${(value as { length: number }).length} bytes]`;
  }
  // AttachmentBuilder — { attachment: Buffer, name, ... }. Collapse to its name.
  if (typeof value === "object" && "attachment" in value && "name" in value) {
    return { _attachment: (value as { name: string }).name };
  }
  if (Array.isArray(value)) return value.map(sanitise);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object)) {
      out[k] = sanitise((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Normalise a recorded ack log into a stable, human-meaningful snapshot value:
 * ModalBuilder args are serialised via `.toJSON()` (embeds/components are already
 * JSON in the dispatcher body); binary attachments are collapsed to their name.
 * Returns the ordered list the branch produced.
 */
export function snapshotAcks(acks: Recorded[]): unknown {
  return acks.map(({ method, arg }) => {
    if (method === "showModal" && arg && typeof (arg as { toJSON?: unknown }).toJSON === "function") {
      return { method, arg: sanitise((arg as { toJSON: () => unknown }).toJSON()) };
    }
    return { method, arg: sanitise(arg ?? null) };
  });
}
