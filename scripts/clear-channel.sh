#!/usr/bin/env bash
# Clear bot messages from a Discord channel using the REST API.
# Usage: ./scripts/clear-channel.sh <channel_id>
#        ./scripts/clear-channel.sh              # reads CLEAR_CHANNEL_ID from .env
#        ./scripts/clear-channel.sh <channel_id> old   # also purge messages >14 days (delete one-by-one)
#
# Reads DISCORD_TOKEN from .env.  Respects Discord's 14-day bulk-delete window.
# Messages older than 14 days require the "old" flag and are deleted individually
# (rate-limited: ~50/s sustained).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_DIR/.env"

# ── Load .env ──
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

TOKEN="${DISCORD_TOKEN:-}"
CHANNEL_ID="${1:-${CLEAR_CHANNEL_ID:-}}"
MODE="${2:-recent}"  # recent | old

# ── Validate ──
if [ -z "$TOKEN" ]; then
  echo "FATAL: DISCORD_TOKEN not set in .env" >&2
  exit 1
fi
if [ -z "$CHANNEL_ID" ]; then
  echo "Usage: $0 <channel_id> [old]" >&2
  echo "       or set CLEAR_CHANNEL_ID in .env" >&2
  exit 1
fi

# ── Resolve bot user ID ──
BOT_INFO=$(curl -sf -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me)
BOT_ID=$(echo "$BOT_INFO" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
if [ -z "$BOT_ID" ]; then
  echo "FATAL: could not resolve bot user ID" >&2
  exit 1
fi
echo "🔍 Bot user: $BOT_ID"

API="https://discord.com/api/v10"

# ── Collect bot message IDs, newest-first ──
echo "🔍 Scanning channel $CHANNEL_ID for bot messages..."
MESSAGE_IDS=()
LAST_ID=""
PAGE=0
MAX_PAGES=50

while [ "$PAGE" -lt "$MAX_PAGES" ]; do
  URL="$API/channels/$CHANNEL_ID/messages?limit=100"
  [ -n "$LAST_ID" ] && URL="$URL&before=$LAST_ID"

  RESP=$(curl -sf -H "Authorization: Bot $TOKEN" "$URL" 2>/dev/null || echo "")
  if [ -z "$RESP" ] || [ "$RESP" = "[]" ]; then
    break
  fi

  # Extract bot message IDs using Python (reliable JSON parsing, field-order independent)
  NEW_IDS=$(echo "$RESP" | python3 -c "
import json, sys
try:
    msgs = json.load(sys.stdin)
    bot_id = '$BOT_ID'
    for m in msgs:
        if m.get('author', {}).get('id') == bot_id:
            print(m['id'])
except Exception:
    pass
" 2>/dev/null || true)

  while IFS= read -r id; do
    [ -n "$id" ] && MESSAGE_IDS+=("$id")
  done <<< "$NEW_IDS"

  # Get the oldest message ID on this page for pagination
  LAST_ID=$(echo "$RESP" | python3 -c "
import json, sys
try:
    msgs = json.load(sys.stdin)
    if msgs:
        print(msgs[-1]['id'])
except: pass
" 2>/dev/null || echo "")

  PAGE=$((PAGE + 1))
  echo "  Page $PAGE: ${#MESSAGE_IDS[@]} bot messages found so far..."

  # If we got fewer than 100 messages, no more pages
  MSG_COUNT=$(echo "$RESP" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  [ "$MSG_COUNT" -lt 100 ] && break
done

TOTAL=${#MESSAGE_IDS[@]}
echo "📊 Found $TOTAL bot message(s) to delete."

if [ "$TOTAL" -eq 0 ]; then
  echo "✅ Nothing to do."
  exit 0
fi

# ── Delete ──
DELETED=0
FAILED=0
BATCH=()

# Discord snowflake epoch: 2015-01-01T00:00:00Z
SNOWFLAKE_EPOCH=1420070400000
NOW_MS=$(($(date +%s) * 1000))
CUTOFF_MS=$((NOW_MS - 14 * 24 * 60 * 60 * 1000))

echo "🗑️  Deleting..."

delete_batch() {
  local ids=("$@")
  if [ ${#ids[@]} -eq 0 ]; then return; fi
  local json_ids="["
  local first=true
  for id in "${ids[@]}"; do
    $first && first=false || json_ids="$json_ids,"
    json_ids="$json_ids\"$id\""
  done
  json_ids="$json_ids]"

  if [ ${#ids[@]} -eq 1 ]; then
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
      -H "Authorization: Bot $TOKEN" \
      "$API/channels/$CHANNEL_ID/messages/${ids[0]}")
  else
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      -H "Authorization: Bot $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"messages\":$json_ids}" \
      "$API/channels/$CHANNEL_ID/messages/bulk-delete")
  fi

  if [ "$CODE" = "204" ] || [ "$CODE" = "200" ]; then
    DELETED=$((DELETED + ${#ids[@]}))
  else
    if [ ${#ids[@]} -gt 1 ]; then
      echo "  ⚠️  Bulk delete returned $CODE, falling back to individual..."
      for sid in "${ids[@]}"; do
        SCODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
          -H "Authorization: Bot $TOKEN" \
          "$API/channels/$CHANNEL_ID/messages/$sid")
        if [ "$SCODE" = "204" ] || [ "$SCODE" = "200" ]; then
          DELETED=$((DELETED + 1))
        else
          FAILED=$((FAILED + 1))
          echo "  ⚠️  Failed to delete $sid (HTTP $SCODE)"
        fi
        sleep 0.05
      done
    else
      FAILED=$((FAILED + 1))
      echo "  ⚠️  Failed to delete ${ids[0]} (HTTP $CODE)"
    fi
  fi
}

for msg_id in "${MESSAGE_IDS[@]}"; do
  # Snowflake timestamp: (id >> 22) + epoch
  TIMESTAMP_MS=$(((msg_id >> 22) + SNOWFLAKE_EPOCH))
  if [ "$TIMESTAMP_MS" -lt "$CUTOFF_MS" ]; then
    if [ "$MODE" != "old" ]; then
      echo "  ⏭️  Skipping $msg_id (older than 14 days — use '$0 $CHANNEL_ID old' to force)"
      continue
    fi
    delete_batch "$msg_id"
  else
    BATCH+=("$msg_id")
    if [ ${#BATCH[@]} -eq 100 ]; then
      delete_batch "${BATCH[@]}"
      BATCH=()
      sleep 1
    fi
  fi
done

if [ ${#BATCH[@]} -gt 0 ]; then
  delete_batch "${BATCH[@]}"
fi

echo ""
echo "✅ Done: $DELETED deleted, $FAILED failed"
