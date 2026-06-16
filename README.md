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
| **Phase 1<br>Design** | Explore mechanics, engine, UX, and world.                                    | Ongoing |
| **Phase 2<br>POC**    | A bot that rolls dice and shows an ASCII tree.                               | Next    |
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

## Planned architecture

```
Discord Bot (TypeScript)
  ├── Command router
  ├── Daily roll engine
  ├── ASCII art renderer
  ├── Auto-sim engine (PC + NPC)
  ├── NPC routine simulation
  ├── Daily economy tick
  ├── Weekly scheduler (cron)
  │
  ├── Graph DB (SQLite + custom edge model)
  │   └── Nodes: Characters, Locations, NPCs, Items, Quests
  │   └── Edges: trust, rivalry, owns, at_location, on_quest…
  │
  └── LLM Gateway (token-optimized, lazy evaluation)
      └── Narrative generation, NPC dialogue, quest creation
```

---

## Running

### Local dev (quick)

```bash
cp .env.example .env      # then fill in DISCORD_TOKEN, DEEPSEEK_API_KEY, ADMIN_USER_ID, TICK_CHANNEL_ID
npm install
npx tsx src/index.ts
```

SQLite lives at `./data/daily-pixel.db` (auto-created). No build step — `tsx` runs TypeScript directly.

### Podman (dev container)

**Build:**
```bash
podman build -t daily-pixel-dev .
```

**Run (foreground — logs stream to terminal):**
```bash
podman run --rm -it \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  daily-pixel-dev
```

**Run (detached — runs in background):**
```bash
podman run -d --name daily-pixel \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  daily-pixel-dev
```

**Tail logs from detached container:**
```bash
podman logs -f daily-pixel
```

**Rebuild & restart (one-liner):**
```bash
podman stop daily-pixel 2>/dev/null; podman rm daily-pixel 2>/dev/null; podman build -t daily-pixel-dev . && podman run -d --name daily-pixel -v $(pwd)/data:/app/data --env-file .env daily-pixel-dev && podman logs -f daily-pixel
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

The bot starts immediately. The timer checks for new commits on `poc` branch every hour and restarts the bot if there are updates. See [`scripts/deploy-check.sh`](./scripts/deploy-check.sh) for the update logic.

---

## License

MIT — see [LICENSE](./LICENSE)
