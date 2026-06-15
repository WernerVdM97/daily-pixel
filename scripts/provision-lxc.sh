#!/usr/bin/env bash
set -euo pipefail

CONTAINER="daily-pixel"
REPO_URL="git@github.com:WernerVdM97/daily-pixel.git"

echo "[provision] Creating Debian 12 LXC container: $CONTAINER"

# Create Debian 12 container
lxc-create -n "$CONTAINER" -t debian -- -r bookworm
lxc-start -n "$CONTAINER"

echo "[provision] Installing dependencies"

lxc-attach -n "$CONTAINER" -- bash -c "
  apt update && apt install -y nodejs npm git curl
  useradd -m -s /bin/bash bot
"

echo "[provision] Cloning repo (poc branch)"

lxc-attach -n "$CONTAINER" -- bash -c "
  su - bot -c 'git clone -b poc $REPO_URL /home/bot/app'
  su - bot -c 'cd /home/bot/app && npm install'
"

echo "[provision] ─────────────────────────────────────────────"
echo "[provision]  NEXT STEPS (manual):"
echo "[provision]"
echo "[provision]  1. Place .env at /home/bot/app/.env with:"
echo "[provision]       DISCORD_TOKEN=<token>"
echo "[provision]       DEEPSEEK_API_KEY=<key>"
echo "[provision]       ADMIN_USER_ID=<your-discord-id>"
echo "[provision]       TICK_CHANNEL_ID=<channel-id>"
echo "[provision]"
echo "[provision]  2. Install systemd units:"
echo "[provision]       cp app/scripts/daily-pixel.service /etc/systemd/system/"
echo "[provision]       cp app/scripts/daily-pixel-deploy.service /etc/systemd/system/"
echo "[provision]       cp app/scripts/daily-pixel-deploy.timer /etc/systemd/system/"
echo "[provision]"
echo "[provision]  3. Enable and start:"
echo "[provision]       systemctl enable --now daily-pixel"
echo "[provision]       systemctl enable --now daily-pixel-deploy.timer"
echo "[provision] ─────────────────────────────────────────────"
echo "[provision] Done."
