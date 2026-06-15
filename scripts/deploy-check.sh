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
