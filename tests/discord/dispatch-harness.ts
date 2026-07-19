import { vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MockWorldEngine } from "../../src/engine/MockWorldEngine.js";
import { SessionController } from "../../src/controller/SessionController.js";
import { WizardSession } from "../../src/discord/WizardSession.js";
import { CommandRegistry, type CommandHandler } from "../../src/discord/CommandRegistry.js";
import { loadYamlFile } from "../../src/assets/yaml-loader.js";
import type { DispatchDeps } from "../../src/discord/dispatchInteraction.js";
import type { DayJobDef } from "../../src/controller/dayJob.js";
import type { CharDefs } from "../../src/discord/commands/join.js";

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
// test stubs where no transcript drives the real collaborator:
//   • the `look` scene-renderer (~below) is stubbed (`() => ({ sceneName, ascii })`)
//     rather than resolving real tags→scene, because `/look` is driven by no transcript.
//   • `getCurrentScene` (passed into the action command) is a FIXED realistic scene
//     string (see makeHarness) rather than main()'s live tag→scene resolution — the
//     only path that reaches it is the outcome render, and a stable value is all the
//     golden transcripts need there.
// Everything else registers exactly as main() does.

const asHandler = (fn: unknown): CommandHandler => fn as CommandHandler;

/** Adapts a `{ user, text }` handler to a slash command (as index.ts's withTextOption). */
function withTextOption(
  fn: (i: { user: { id: string }; text: string }) => Promise<string>,
): CommandHandler {
  return async (interaction: unknown) => {
    const cmd = interaction as {
      user: { id: string };
      options: { getString: (n: string, req?: boolean) => string };
    };
    const text = cmd.options.getString("text", true);
    return fn({ user: { id: cmd.user.id }, text });
  };
}

export function buildRegistry(
  engine: MockWorldEngine,
  joinWizards: WizardSession,
  getCurrentScene: (userId: string) => string,
): CommandRegistry {
  const registry = new CommandRegistry();

  registry.register(
    "ping",
    asHandler(async () => "pong"),
  );
  registry.register("help", asHandler(makeHelpCommand()));
  registry.register("stats", asHandler(makeStatsCommand(engine)));
  registry.register("backpack", asHandler(makeBackpackCommand(engine)));
  registry.register(
    "look",
    asHandler(
      makeLookCommand(engine, () => ({ sceneName: "test", ascii: "..." })),
    ),
  );
  registry.register("journal", asHandler(makeJournalCommand(engine)));
  const mapCommand = makeMapCommand(engine);
  registry.register("map", async (interaction: unknown) => {
    const cmd = interaction as {
      user: { id: string };
      options?: { getString?: (n: string) => string | null };
    };
    const focus =
      typeof cmd.options?.getString === "function"
        ? cmd.options.getString("place") ?? undefined
        : undefined;
    return mapCommand({ user: { id: cmd.user.id }, focus });
  });
  registry.register("feedback", withTextOption(makeFeedbackCommand(engine)));
  registry.register("bug", withTextOption(makeBugCommand(engine)));
  registry.register("sleep", asHandler(makeSleepCommand(engine, DAY_JOBS)));
  registry.register("hi", asHandler(makeHiCommand(engine, DAY_JOBS)));
  registry.register(
    "join",
    asHandler(makeJoinCommand(engine, joinWizards, CHAR_DEFS)),
  );
  registry.register(
    "action",
    asHandler(makeActionCommand(engine, getCurrentScene, DAY_JOBS)),
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
  const registry = buildRegistry(engine, joinWizards, getCurrentScene);
  const notifyAdmin = vi.fn(async () => {});
  const safeErrorReply = vi.fn(async () => {});

  const deps: DispatchDeps = {
    engine,
    registry,
    getCurrentScene,
    dayJobs: DAY_JOBS,
    joinWizards,
    controller: new SessionController(engine, getCurrentScene, DAY_JOBS),
    notifyAdmin,
    safeErrorReply,
    VERBOSE: false,
    ADMIN_USER_ID: "admin-000",
    CHARACTER_GATED_COMMANDS,
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
  // reply/deferReply flip the replied/deferred flags the slash arm early-returns on.
  intr.reply = vi.fn(async (arg?: unknown) => {
    acks.push({ method: "reply", arg: arg ?? null });
    intr.replied = true;
  });
  intr.deferReply = vi.fn(async (arg?: unknown) => {
    acks.push({ method: "deferReply", arg: arg ?? null });
    intr.deferred = true;
  });
  intr.editReply = spy("editReply");
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
    reply: spy("reply"),
    update: spy("update"),
    deferReply: spy("deferReply"),
    deferUpdate: spy("deferUpdate"),
    editReply: spy("editReply"),
    followUp: spy("followUp"),
    fetchReply: spy("fetchReply", () => ({ id: "msg-1" })),
    showModal: spy("showModal"),
    webhook: {
      editMessage: vi.fn(async (_id: string, payload: unknown) => {
        acks.push({ method: "webhook.editMessage", arg: payload });
      }),
    },
  };
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
    reply: spy("reply"),
    update: spy("update"),
    deferReply: spy("deferReply"),
    deferUpdate: spy("deferUpdate"),
    editReply: spy("editReply"),
    followUp: spy("followUp"),
    fetchReply: spy("fetchReply", () => ({ id: "msg-1" })),
    webhook: {
      editMessage: vi.fn(async (_id: string, payload: unknown) => {
        acks.push({ method: "webhook.editMessage", arg: payload });
      }),
    },
  };
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
