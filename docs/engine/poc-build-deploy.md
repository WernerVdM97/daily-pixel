# POC Build & Deploy

Run and deploy The Warden's Oak during the POC phase.

## Local dev (quick)

```bash
cp .env.example .env      # fill in DISCORD_TOKEN, DEEPSEEK_API_KEY, ADMIN_USER_ID, TICK_CHANNEL_ID
npm install
npx tsx --env-file=.env src/index.ts
```

SQLite lives at `./data/warden.db` (auto-created). No build step — `tsx` runs TypeScript directly.

## Podman (dev container)

**Bind-mount permissions (`:U`).** The image runs as a non-root user (`USER bot` in the `Containerfile`). Under rootless podman your host UID maps to the container's *root*, so the `bot` process can't write to a host-owned bind mount — SQLite then fails to open the db with `SQLITE_CANTOPEN`. The **`:U`** flag tells podman to chown the mounted `./data` to the container user, fixing it. Caveat: `:U` flips `./data`'s ownership to a subuid on the host, so don't alternate between podman and local (`tsx`) runs against the same `./data` — the ownership will ping-pong. Pick one mode; for a quick test loop, local is simplest.

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

SQLite persists in `./data/`. `.env` is mounted at runtime, never baked into the image. See [`Containerfile`](../../Containerfile).

## Inspecting the database

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

## Production (LXC Debian)

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

The bot starts immediately. The timer checks for new commits on the `main` branch every hour and restarts the bot if there are updates. See [`scripts/deploy-check.sh`](../../scripts/deploy-check.sh) for the update logic.

**Auto-deploy gotchas:**
- The deploy timer must be explicitly enabled: `systemctl enable --now daily-pixel-deploy.timer`. It does not start automatically after copying the unit files.
- `deploy-check.sh` must be executable (`chmod +x /home/bot/app/scripts/deploy-check.sh`). If missing, systemd will fail with `Permission denied` on each timer trigger.
- Verify the timer is active: `systemctl is-active daily-pixel-deploy.timer`.
