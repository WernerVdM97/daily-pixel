#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/bot/app"
SERVICE_NAME="daily-pixel"
BRANCH="main"

# Run git/npm as the bot user, systemctl as root
su - bot -c "cd '$PROJECT_DIR' && git checkout '$BRANCH' && git fetch origin"

LOCAL=$(su - bot -c "cd '$PROJECT_DIR' && git rev-parse HEAD")
REMOTE=$(su - bot -c "cd '$PROJECT_DIR' && git rev-parse 'origin/$BRANCH'")

if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0
fi

echo "[deploy] New commit: ${REMOTE:0:7}"
su - bot -c "cd '$PROJECT_DIR' && git pull origin '$BRANCH'"
su - bot -c "cd '$PROJECT_DIR' && npm ci"

# Verification gate: only restart if new code compiles
su - bot -c "cd '$PROJECT_DIR' && npx tsc --noEmit"
echo "[deploy] Typecheck passed — restarting..."
systemctl restart "$SERVICE_NAME"
echo "[deploy] Done — running ${REMOTE:0:7}"
