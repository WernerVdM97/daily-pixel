---
title: POC Build — Deploy
status: decided
domain: engine
phase: poc
tags:
- poc
- build-plan
- deploy
related:
- '[[poc-build-poa]]'
- '[[poc-tech-stack]]'
- '[[poc-spec-reconciliation]]'
---

# POC Build — Deploy

> *Part of the POC build ([[poc-build-poa]]). Dev environment, CI/CD, LXC provisioning, production deploy, auto-update, and tester invite.*

---

## 1. CI — GitHub Actions

`.github/workflows/ci.yml` — runs on push and PR to `poc` branch.

```yaml
name: ci

on:
  push:
    branches: [poc]
  pull_request:
    branches: [poc]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - name: Install
        run: npm ci

      - name: Typecheck
        run: npx tsc --noEmit

      - name: Security audit
        run: npm audit --audit-level=high
        continue-on-error: true
```

No `npm run build` — `tsx` runs TypeScript directly. Typecheck via `tsc --noEmit`.

---

## 2. Dev Environment — Podman

`Containerfile` at repo root for local development.

```dockerfile
FROM debian:12
RUN apt update && apt install -y nodejs npm git curl && \
    useradd -m bot
USER bot
WORKDIR /home/bot/app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npx", "tsx", "src/index.ts"]
```

**Run locally:**
```bash
podman build -t daily-pixel-dev .
podman run --rm -it \
  -v $(pwd)/data:/home/bot/app/data \
  --env-file .env \
  daily-pixel-dev
```

SQLite persists in `./data/`. `.env` mounted at runtime, never baked into the image.

---

## 3. Production — LXC Provisioning

`scripts/provision-lxc.sh` — run once on the Debian 12 host.

```bash
#!/usr/bin/env bash
set -euo pipefail

CONTAINER="daily-pixel"
REPO_URL="git@github.com:username/daily-pixel.git"

# Create Debian 12 container
lxc-create -n "$CONTAINER" -t debian -- -r bookworm
lxc-start -n "$CONTAINER"

# Install deps
lxc-attach -n "$CONTAINER" -- bash -c "
  apt update && apt install -y nodejs npm git curl
  useradd -m -s /bin/bash bot
"

# Clone repo on poc branch
lxc-attach -n "$CONTAINER" -- bash -c "
  su - bot -c 'git clone -b poc $REPO_URL /home/bot/app'
  su - bot -c 'cd /home/bot/app && npm install'
"

# Place env file (manual step — contains secrets)
echo "Place .env at /home/bot/app/.env with DISCORD_TOKEN, DEEPSEEK_API_KEY, ADMIN_USER_ID, TICK_CHANNEL_ID"
```

---

## 4. Production — systemd Units

Three units: the bot itself, an hourly deploy check, and a timer.

### `daily-pixel.service`

```
[Unit]
Description=Daily Pixel Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bot
WorkingDirectory=/home/bot/app
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=always
RestartSec=10
EnvironmentFile=/home/bot/app/.env

[Install]
WantedBy=multi-user.target
```

### `daily-pixel-deploy.service`

```
[Unit]
Description=Check for Daily Pixel updates

[Service]
Type=oneshot
User=bot
ExecStart=/home/bot/app/scripts/deploy-check.sh
```

### `daily-pixel-deploy.timer`

```
[Unit]
Description=Hourly check for Daily Pixel updates
After=network-online.target
Wants=network-online.target

[Timer]
OnBootSec=2min
OnUnitActiveSec=1h
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
```

### `scripts/deploy-check.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/bot/app"
SERVICE_NAME="daily-pixel"
BRANCH="poc"

cd "$PROJECT_DIR"
git checkout "$BRANCH"
git fetch origin

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0
fi

echo "[deploy] New commit: ${REMOTE:0:7}"
git pull origin "$BRANCH"
npm install
echo "[deploy] Restarting..."
systemctl restart "$SERVICE_NAME"
echo "[deploy] Done — running ${REMOTE:0:7}"
```

### Enable

```bash
systemctl enable --now daily-pixel
systemctl enable --now daily-pixel-deploy.timer
```

Bot starts immediately. Timer checks every hour (±2 min jitter) and restarts if `poc` branch has new commits.

---

## 5. Invite Testers

- Generate Discord bot invite link (bot + applications.commands scopes)
- Create test Discord server
- Invite 8 friends
- Pin welcome message:

> **Welcome to The Warden's Oak.**
>
> You are the last to arrive at the Oak — a sanctuary in a world slowly
> unraveling. Each day you'll wake, take actions, make choices, and see
> how your decisions ripple through the world.
>
> **Commands:** `/join` to create your character. `/hi` to begin.
> `/help` for everything else.
>
> This is a POC. Things will break. Use `/bug` and `/feedback` liberally.

---

## S7 Handover

- [x] **Shipped:** CI workflow `.github/workflows/ci.yml` targeting `poc` branch with concurrency group, quality gates (typecheck + test + audit). `Containerfile` at repo root for Podman dev. `scripts/provision-lxc.sh` (LXC provisioning), `scripts/deploy-check.sh` (auto-update on `poc` branch commits), systemd unit files (`scripts/daily-pixel.service`, `.deploy.service`, `.deploy.timer`). **30-min timeout auto-fail runtime hook:** `InternalActionState.lastActionAt` stamped on every persist; `isStateStale()` helper clears state + inserts `timed_out` action row when >30 min stale; checked on `resumeAction()` and `stepAction()`; pattern added to `ErrorMapper`.
- [!] **Frozen:** `InternalActionState.lastActionAt` added to the state machine interface — stored in the JSON column alongside existing fields. `isStateStale()` is a module-level function in `WorldEngineImpl.ts`, not on the `WorldEngine` interface. `ACTION_TIMEOUT_MS = 30 * 60 * 1000` in `WorldEngineImpl.ts`. No changes to `WorldEngine.ts` or `LlmGateway.ts` (seam still clean).
- [x] **Tests:** 377 passing (7 new), 33 files. Run: `cd ~/projects/daily-pixel && npx vitest run`. `tsc --noEmit` clean. New file: `tests/engine/action-timeout.test.ts` (6 tests: stale resume, stale step, non-stale resume, non-stale step, backward compat without lastActionAt, just-under-30min edge). Updated: `tests/engine/error-mapper.test.ts` (added `timed out after 30 minutes` pattern).
- [>] **Next (human-deferred):** Manual typos pass on all text output, mobile full-flow test on phone Discord, deploy to LXC (run `scripts/provision-lxc.sh`, place `.env`, enable systemd units), invite 8 testers with the pin message, monitor against §6 success criteria.

---

## 6. Observe

Track against these success criteria — **green light for MVP if the first two pass**:

| Criterion | Threshold | How to check |
|---|---|---|
| 4/8 testers complete an action | Pass | `SELECT COUNT(DISTINCT character_id) FROM actions` |
| 2/8 return day 2 unprompted | Pass | Actions spanning ≥2 dates per character |
| One asks about the world | Bonus | Observational — DMs, questions in chat |
| Zero "I don't get it" | Bonus | Scan `/feedback` for confusion signals |
| Full flow works on mobile | Must-pass | Manual test on phone Discord |
| LLM feels coherent | Must-pass | Sample `decisions_json`. Fallback rate <10%. |

Also monitor:
- [I] LLM fallback rate: `meta.llm_fallback_count` ÷ total actions. (Tier-2 fallback inserts no `actions` row, so the counter — not a row count — is the source of truth. See [[poc-build-polish]] §2.)
- [I] Timeout rate (distinct from fallback): `SELECT COUNT(*) FROM actions WHERE outcome = 'timed_out'` as % of total
- [I] `/bug` reports in `bug_reports` table
- [I] SQLite file size (sanity — shouldn't balloon)
