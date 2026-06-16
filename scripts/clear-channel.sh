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
BOT_ID=$(echo "$BOT_INFO" | grep -o '"id":"[0-9]*"' | head -1 | cut -d'"' -f4)
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

while true; do
  URL="$API/channels/$CHANNEL_ID/messages?limit=100"
  [ -n "$LAST_ID" ] && URL="$URL&before=$LAST_ID"

  RESP=$(curl -sf -H "Authorization: Bot $TOKEN" "$URL" 2>/dev/null || echo "")
  if [ -z "$RESP" ] || [ "$RESP" = "[]" ]; then
    break
  fi

  # Extract bot message IDs from this page
  while IFS= read -r id; do
    MESSAGE_IDS+=("$id")
  done < <(echo "$RESP" | grep -o '"id":"[0-9]*","channel_id":"[0-9]*","author":{"id":"'"$BOT_ID"'"' | grep -o '"id":"[0-9]*"' | head -1 | cut -d'"' -f4 || true)

  # Also capture by checking author.id more reliably with a small awk/sed
  while IFS= read -r id; do
    # Avoid duplicates from the simpler grep above
    skip=false
    for e in "${MESSAGE_IDS[@]}"; do [ "$e" = "$id" ] && skip=true && break; done
    $skip && continue
    MESSAGE_IDS+=("$id")
  done < <(echo "$RESP" | python3 -c "
import json,sys
try:
    msgs=json.load(sys.stdin)
    for m in msgs:
        if m.get('author',{}).get('id')=='$BOT_ID':
            print(m['id'])
except: pass
" 2>/dev/null || true)

  LAST_ID=$(echo "$RESP" | grep -o '"id":"[0-9]*"' | head -1 | cut -d'"' -f4)
  PAGE=$((PAGE + 1))
  echo "  Page $PAGE: ${#MESSAGE_IDS[@]} bot messages found so far..."
  # Discord pagination: if we got <100, we're done
  COUNT=$(echo "$RESP" | grep -c '"id":"' || true)
  [ "$COUNT" -lt 100 ] && break
done

TOTAL=${#MESSAGE_IDS[@]}
echo "📊 Found $TOTAL bot message(s) to delete."

if [ "$TOTAL" -eq 0 ]; then
  echo "✅ Nothing to do."
  exit 0
fi

# Reverse so we delete oldest-first (bulk-delete doesn't care about order,
# but single-delete is cleaner chronological).
# We want newest-first for the 14-day check though, so keep as-is (newest-first).

# ── Delete ──
DELETED=0
FAILED=0
BATCH=()

# Discord's bulk-delete endpoint only accepts messages <14 days old.
# Compute the cutoff timestamp (14 days ago in Discord snowflake time).
# Discord snowflake epoch: 2015-01-01T00:00:00Z = 1420070400000 ms
# We'll check message age by snowflake ID.
SNOWFLAKE_EPOCH=1420070400000
NOW_MS=$(date +%s)000
CUTOFF_MS=$((NOW_MS - 14*24*60*60*1000))
CUTOFF_SNOWFLAKE=$(((CUTOFF_MS - SNOWFLAKE_EPOCH) << 22))

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
    # Single delete
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
      -H "Authorization: Bot $TOKEN" \
      "$API/channels/$CHANNEL_ID/messages/${ids[0]}")
  else
    # Bulk delete
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      -H "Authorization: Bot $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"messages\":$json_ids}" \
      "$API/channels/$CHANNEL_ID/messages/bulk-delete")
  fi

  if [ "$CODE" = "204" ] || [ "$CODE" = "200" ]; then
    DELETED=$((DELETED + ${#ids[@]}))
  else
    # If bulk-delete fails (e.g. mix of old/new), fall back to individual
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
        # Rate-limit courtesy
        sleep 0.05
      done
    else
      FAILED=$((FAILED + 1))
      echo "  ⚠️  Failed to delete ${ids[0]} (HTTP $CODE)"
    fi
  fi
}

for msg_id in "${MESSAGE_IDS[@]}"; do
  # Check age
  TIMESTAMP_MS=$(((msg_id >> 22) + SNOWFLAKE_EPOCH))
  if [ "$TIMESTAMP_MS" -lt "$CUTOFF_MS" ]; then
    # Message is older than 14 days — can't bulk-delete
    if [ "$MODE" != "old" ]; then
      echo "  ⏭️  Skipping $msg_id (older than 14 days, use '$0 $CHANNEL_ID old' to force individual delete)"
      continue
    fi
    # Individual delete
    delete_batch "$msg_id"
  else
    BATCH+=("$msg_id")
    if [ ${#BATCH[@]} -eq 100 ]; then
      delete_batch "${BATCH[@]}"
      BATCH=()
      # Rate-limit courtesy: 1s between bulk calls
      sleep 1
    fi
  fi
done

# Flush remaining batch
if [ ${#BATCH[@]} -gt 0 ]; then
  delete_batch "${BATCH[@]}"
fi

echo ""
echo "✅ Done: $DELETED deleted, $FAILED failed"
