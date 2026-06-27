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

- **Cheap by default.** Roll resolution, stat math, and templates run without touching an LLM.
- **Lazy evaluation.** NPCs aren't alive until met. Locations are procedural until visited.
- **Mobile-first Discord.** ~30 char wide ASCII scenes. One message per daily roll batch.
- **Optimised for 8 players.** Thematic choice (a fellowship), not a technical limit.

## Codebase structure

```
daily-pixel/
├── src/
│   ├── index.ts                # Entry point — startup, Discord client, interaction router
│   ├── version.ts              # APP_VERSION constant
│   ├── db/
│   │   ├── schema.sql          # 9 tables + indexes + seed data
│   │   ├── connection.ts       # SQLite init (auto-creates data/ dir)
│   │   ├── migrate.ts          # Idempotent migrations
│   │   └── repositories/       # Row-level data access
│   ├── engine/
│   │   ├── WorldEngineImpl.ts  # Core engine — characters, action flow, tick, items, NPCs
│   │   ├── WorldEngine.ts      # Public interfaces
│   │   ├── StatComputer.ts     # Stat derivation from class/upbringing/race
│   │   ├── OutcomeRenderer.ts  # Action outcome formatting
│   │   ├── ErrorMapper.ts      # Error → user-friendly messages
│   │   ├── IdleMessageSelector.ts
│   │   └── action/
│   │       ├── machine.ts      # Action state machine (start → decide → roll → resolve)
│   │       ├── dc.ts           # DC accumulation, roll bonus, resolution
│   │       └── mutations.ts    # Apply/validate LLM world mutations
│   ├── llm/
│   │   ├── LlmGateway.ts       # Gateway interface & types
│   │   ├── DeepseekLlmGateway.ts
│   │   ├── FallbackLlmGateway.ts  # Retry chain + divine intervention mock
│   │   ├── MockLlmGateway.ts
│   │   ├── LlmCallRecorder.ts  # Audit logging interface
│   │   └── prompt-builder.ts   # System prompt + user message construction (v6)
│   ├── discord/
│   │   ├── CommandRegistry.ts
│   │   ├── WizardSession.ts    # Multi-step join wizard state
│   │   ├── format.ts           # Components V2 helpers, nav buttons
│   │   ├── images.ts           # Cached asset image loader
│   │   ├── profanity.ts        # Configurable profanity filter
│   │   └── commands/           # One file per command (action, hi, join, look, …)
│   ├── scenes/
│   │   ├── SceneLoader.ts      # Loads ASCII art from assets/scenes/
│   │   └── TagResolver.ts      # Location tags → scene name
│   ├── assets/
│   │   ├── ascii-loader.ts
│   │   └── yaml-loader.ts      # Fail-fast YAML config loading
│   └── util/
│       └── colors.ts           # ANSI colour helpers
├── assets/
│   ├── char-creation/          # YAML: classes, races, backgrounds, alignments, day-jobs, item-sets
│   ├── prompts/decision-prompts/  # System prompt versions (v6 active)
│   ├── scenes/                 # 20 ASCII scene files
│   └── ui/                     # Banner images (theoak.png, banner, loading.gif)
├── docs/                       # Design vault — vision, game, engine, UI, decisions, sparks
├── tests/
│   ├── e2e/                    # Full happy-path integration test
│   ├── engine/                 # Action state machine, DC, mutations, stat computer, tick
│   ├── discord/                # Per-command unit tests, format, profanity, wizard
│   ├── db/                     # Repository tests, migration, restart persistence
│   ├── llm/                    # Gateway tests
│   └── scenes/                 # Scene loader, tag resolver
├── scripts/
│   ├── query.mjs               # SQLite inspection with shorthands
│   ├── clear-admin.sh          # Bulk-delete character from DB
│   ├── clear-channel.sh        # Bulk-delete bot messages from a Discord channel
│   ├── deploy-check.sh         # Git pull + restart on new commits
│   ├── daily-pixel.service     # systemd unit
│   ├── daily-pixel-deploy.service
│   └── daily-pixel-deploy.timer  # Hourly deploy check
└── data/                       # SQLite database (gitignored, auto-created)
```

---

## Running

### Local dev (quick)

```bash
cp .env.example .env      # then fill in DISCORD_TOKEN, DEEPSEEK_API_KEY, ADMIN_USER_ID, TICK_CHANNEL_ID
npm install
npx tsx src/index.ts
```

SQLite lives at `./data/warden.db` (auto-created). No build step — `tsx` runs TypeScript directly.

> The bare `npx tsx src/index.ts` does **not** load `.env` — pass it explicitly:
> `npx tsx --env-file=.env src/index.ts` (Node 20.6+ / 22).

### Podman (dev container)

> **Bind-mount permissions (`:U`).** The image runs as a non-root user (`USER bot` in the
> `Containerfile`). Under rootless podman your host UID maps to the container's *root*, so the
> `bot` process can't write to a host-owned bind mount — SQLite then fails to open the db with
> `SQLITE_CANTOPEN`. The **`:U`** flag tells podman to chown the mounted `./data` to the container
> user, fixing it. Caveat: `:U` flips `./data`'s ownership to a subuid on the host, so don't
> alternate between podman and local (`tsx`) runs against the same `./data` — the ownership will
> ping-pong. Pick one mode; for a quick test loop, local is simplest.

**Build:**
```bash
podman build -t daily-pixel-dev .
```

**Run (foreground — logs stream to terminal):**
```bash
podman run --rm -it \
  -v $(pwd)/data:/app/data:U \
  --env-file .env \
  daily-pixel-dev
```

**Run (detached — runs in background):**
```bash
podman run -d --name daily-pixel \
  -v $(pwd)/data:/app/data:U \
  --env-file .env \
  daily-pixel-dev
```

**Tail logs from detached container:**
```bash
podman logs -f daily-pixel
```

**Rebuild & restart (one-liner):**
```bash
podman stop daily-pixel 2>/dev/null; podman rm daily-pixel 2>/dev/null; podman build -t daily-pixel-dev . && podman run -d --name daily-pixel -v $(pwd)/data:/app/data:U --env-file .env daily-pixel-dev && podman logs -f daily-pixel
```

**Stop and remove detached container:**
```bash
podman stop daily-pixel && podman rm daily-pixel
```

SQLite persists in `./data/`. `.env` is mounted at runtime, never baked into the image. See [`Containerfile`](./Containerfile) and [`docs/engine/poc-build-deploy.md`](./docs/engine/poc-build-deploy.md) §2.

### Inspecting the database

Query SQLite directly with the built-in script:

```bash
node scripts/query.mjs last_actions    # recent actions with outcomes
node scripts/query.mjs char            # player_characters (location, stamina, etc.)
node scripts/query.mjs locs            # all known locations
node scripts/query.mjs items           # character inventories
node scripts/query.mjs npcs            # spawned NPCs
node scripts/query.mjs meta            # day_number, fallback_count, etc.
node scripts/query.mjs ".tables"       # list all tables
node scripts/query.mjs "SELECT * FROM actions WHERE outcome = 'failure'"
```

### Production (LXC Debian — prep for later deploy)

These steps assume the Debian 12 LXC container already exists and you're setting up the bot inside it. Run each command via `lxc-attach -n <container> -- <cmd>` or from a root shell inside the container.

**1. System dependencies**

```bash
apt update && apt install -y curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
useradd -m -s /bin/bash bot
```

**2. Clone & install**

```bash
# First, ensure the bot user has SSH access to GitHub (add deploy key or forward ssh-agent)
su - bot -c 'git clone git@github.com:WernerVdM97/daily-pixel.git /home/bot/app'
su - bot -c 'cd /home/bot/app && npm ci'
```

**3. Place `.env`**

Create `/home/bot/app/.env` with your secrets:

```
DISCORD_TOKEN=...
DEEPSEEK_API_KEY=...
ADMIN_USER_ID=...
TICK_CHANNEL_ID=...
```

**4. Install systemd units**

```bash
cp /home/bot/app/scripts/daily-pixel.service /etc/systemd/system/
cp /home/bot/app/scripts/daily-pixel-deploy.service /etc/systemd/system/
cp /home/bot/app/scripts/daily-pixel-deploy.timer /etc/systemd/system/
systemctl daemon-reload
```

**5. Enable & start**

```bash
systemctl enable --now daily-pixel
systemctl enable --now daily-pixel-deploy.timer
```

The bot starts immediately. The timer checks for new commits on the `main` branch every hour and restarts the bot if there are updates. See [`scripts/deploy-check.sh`](./scripts/deploy-check.sh) for the update logic.

> ⚠️ **Auto-deploy gotchas:**
> - The deploy timer must be explicitly enabled: `systemctl enable --now daily-pixel-deploy.timer`. It does not start automatically after copying the unit files.
> - `deploy-check.sh` must be executable (`chmod +x /home/bot/app/scripts/deploy-check.sh`). If missing, systemd will fail with `Permission denied` on each timer trigger.
> - Verify the timer is active: `systemctl is-active daily-pixel-deploy.timer`.

---

## License

MIT — see [LICENSE](./LICENSE)
