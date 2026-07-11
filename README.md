# The Warden's Oak

![wardens-oak](./docs/assets/wardens-oak.jpg)

> *A year is a long time to carry an ember. But it's longer still to carry one alone.*

A daily Discord RPG where strangers become a fellowship — decisions, dice rolls, one tree at a crossroads, and trouble waking in the east.

---

## What is this?

The Warden's Oak is a slow-burn narrative game played over a real calendar year. Each day, players get two d20 rolls — more on weekends — to travel, rest, or act, and the world advances around them. Miss a day? Your character rests by the fire. Miss too many? The world moves on without you.

It draws from **MUD** (text-rendered multi-user dungeon), **Frieren** (time as tension), **D&D** (visible dice), **Lord of the Rings** (fellowship of many), **Castlevania** (gothic threat on the horizon), **anime** (friendship as mechanic), **MapleStory** (the social grind as ritual), and **Fable** (NPCs who live their own lives).

## Visual Guides

 - [gameplay loop](./docs/assets/core-loop.png)
 - [character creation](./docs/assets/character-creation.png)

---

## Roadmap

| Phase    .            | What                                                                         | Status  |
| --------------------- | ---------------------------------------------------------------------------- | ------- |
| **Phase 1<br>Design** | Explore mechanics, engine, UX, and world.                                    | Done    |
| **Phase 2<br>POC**    | A bot that rolls dice and shows an ASCII tree.                               | Ongoing |
| **Phase 3<br>MVP**    | Daily decision leading up to rolls, co-op, NPC basics, weekly rhythm.        | Planned |
| **Phase 4<br>MVP+**   | Year-long campaign. NPC economy, moral drift, LLM narratives, finall climax. | Distant |

## Design docs

The full design vault lives in `docs/` — every idea, mechanic, and decision.

Start with 
- [`docs/README.md`](./docs/README.md) (the map of content), and
- [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) (how docs are organised).

---

## Design principles

- **Lazy evaluation.** NPCs aren't alive until met. Locations are procedural until visited.
- **Mobile-first Discord.** ~30 char wide ASCII scenes. One message per daily roll batch.
- **Optimised for ~8 players.** Thematic choice (a fellowship), not a technical limit.

## Codebase structure

```
daily-pixel/
├── src/
│   ├── index.ts                    # Entry point - startup, Discord client, interaction router
│   ├── version.ts                  # APP_VERSION constant
│   ├── config/
│   │   └── env.ts                  # Central logging/debug env contract (shared by both gateways)
│   ├── db/
│   │   ├── schema.sql              # Tables + indexes + seed data
│   │   ├── connection.ts           # SQLite init
│   │   ├── migrate.ts              # Idempotent migrations
│   │   ├── migrations/             # Dated migration files (+ index, types)
│   │   └── repositories/           # Row-level data access (action, character, item, location, edge, NPC, relation, llm-call, meta, …)
│   ├── engine/
│   │   ├── WorldEngineImpl.ts      # Core engine - characters, tick, items, NPCs
│   │   ├── WorldEngine.ts          # Public interfaces
│   │   ├── MockWorldEngine.ts      # In-memory engine for tests
│   │   ├── StatComputer.ts         # Stat derivation from class/upbringing/race
│   │   ├── stat-format.ts          # Stat labels + emoji for rendered output
│   │   ├── OutcomeRenderer.ts      # Action outcome formatting
│   │   ├── authored-text.ts        # Neutralize LLM/player free text before persist + re-emit
│   │   ├── ErrorMapper.ts          # Errors -> user-facing Discord messages
│   │   ├── IdleMessageSelector.ts  # Atmospheric "waiting for LLM" lines
│   │   ├── geography.ts            # Map graph traversal
│   │   ├── geography-finalize.ts   # Travel mutation validation
│   │   └── action/
│   │       ├── machine.ts          # Legacy action state machine (v11)
│   │       ├── PipelineActionStateMachine.ts  # v12 pipeline (classify -> decide -> resolve)
│   │       ├── dc.ts               # DC accumulation, roll bonus, resolution
│   │       ├── combat-dc.ts        # Contested-roll -> severity-band math (combat)
│   │       ├── combat-state.ts     # in_combat / combat_save scene-state model
│   │       ├── mutations.ts        # Apply/validate LLM world mutations
│   │       ├── relation-wiring.ts  # Authored relation endpoints -> id resolution
│   │       ├── pipeline-context.ts # Per-call context for the v12 pipeline
│   │       └── travel-gate.ts      # Travel coherence backstop
│   ├── llm/
│   │   ├── LlmGateway.ts           # Gateway interface & types
│   │   ├── DeepseekLlmGateway.ts   # v11 monolithic DeepSeek gateway
│   │   ├── deepseek-transport.ts   # Shared raw HTTP mechanics for DeepSeek calls
│   │   ├── FallbackLlmGateway.ts   # Retry chain + divine intervention mock
│   │   ├── CritiquedLlmGateway.ts  # Coherence critic decorator
│   │   ├── MockLlmGateway.ts
│   │   ├── LlmCallRecorder.ts      # Audit logging interface
│   │   ├── capture-policy.ts       # Deep-capture (raw prompt + thinking) gating
│   │   ├── prompt-builder.ts       # System prompt + user message (v11, v12 set loader)
│   │   └── pipeline/               # v12 pipeline: classifier, prod gateway, messages, parse, stamping, types
│   ├── discord/
│   │   ├── CommandRegistry.ts
│   │   ├── WizardSession.ts        # Multi-step join wizard
│   │   ├── format.ts               # Components V2 helpers, nav buttons
│   │   ├── images.ts               # Cached asset image loader
│   │   ├── profanity.ts            # Configurable profanity filter
│   │   ├── map-render.ts           # /map ASCII rendering
│   │   ├── announcements.ts        # Twice-daily morning/evening posts
│   │   ├── collapse.ts             # "A soul has bottomed out" world notices
│   │   ├── pin.ts / release-notes.ts / weekly-recap.ts / afternoon.ts
│   │   └── commands/               # One file per /command
│   ├── render/
│   │   ├── AnsiRenderer.ts         # Coloured ANSI frame rendering for Discord
│   │   ├── CombatCardRenderer.ts   # Combat-card composers (continue / terminal)
│   │   ├── OpeningFrameRenderer.ts # Per-action opening scene-setter frame
│   │   └── palette.ts              # Colour roles -> Discord ANSI SGR mapping
│   ├── sim/                        # Offline simulation harness (Thread B/C tuning) + scenarios
│   ├── scenes/
│   │   ├── SceneLoader.ts          # Loads ASCII art from assets/scenes/
│   │   └── TagResolver.ts          # Location tags -> scene name
│   ├── assets/
│   │   ├── yaml-loader.ts          # Fail-fast YAML config loading
│   │   ├── ascii-loader.ts         # Fail-fast ASCII art loading
│   │   └── asset-schemas.ts        # Runtime validators for shipped YAML assets
│   └── util/
│       └── colors.ts               # ANSI colour helpers
├── assets/
│   ├── char-creation/              # YAML: classes, races, backgrounds, alignments, day-jobs, item-sets
│   ├── prompts/
│   │   ├── decision-prompts/       # v11 (monolithic) + v12 (phase-split set)
│   │   │   ├── decision-v11.md
│   │   │   └── v12/
│   │   │       ├── classify.md
│   │   │       ├── decide/         # BASE + phases/ + per-type (combat, travel, …)
│   │   │       └── resolve/        # BASE + per-type-per-verdict success/failure
│   │   └── critic/                 # Coherence critic prompts
│   ├── scenes/                     # ASCII scene files
│   ├── ui/                         # Banner images
│   └── release-notes/              # Per-version player release notes YAML
├── docs/                           # Design vault — see docs/README.md for the map of content
├── tests/                          # e2e, engine, discord, db, llm, scenes, sim
├── scripts/                        # query.mjs, systemd units, deploy helpers
└── data/                           # SQLite database (gitignored, auto-created)
```

---

## Running

### Quick start

```bash
cp .env.example .env      # fill in DISCORD_TOKEN, DEEPSEEK_API_KEY, ADMIN_USER_ID, TICK_CHANNEL_ID
npm install
npx tsx --env-file=.env src/index.ts
```

SQLite lives at `./data/warden.db` (auto-created). No build step — `tsx` runs TypeScript directly.

### DB inspection

```bash
node scripts/query.mjs last_actions    # recent actions with outcomes
node scripts/query.mjs char            # player_characters
node scripts/query.mjs locs            # all known locations
node scripts/query.mjs items           # character inventories
node scripts/query.mjs npcs            # spawned NPCs
node scripts/query.mjs ".tables"       # list all tables
```

**Podman dev container, production deploy (LXC), and systemd setup** → [`docs/engine/poc-build-deploy.md`](./docs/engine/poc-build-deploy.md).

MIT — see [LICENSE](./LICENSE)
