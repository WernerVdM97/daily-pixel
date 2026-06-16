#!/usr/bin/env bash
# Clear a user's character from the DB.
# Usage: ./scripts/clear-admin.sh                # reads ADMIN_USER_ID from .env
#        ./scripts/clear-admin.sh 123456789      # explicit discord user ID
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
DB="$REPO_DIR/data/warden.db"
TMP="/tmp/warden-clear.db"

DISCORD_ID="${1:-}"
if [ -z "$DISCORD_ID" ]; then
  DISCORD_ID="$(grep ADMIN_USER_ID "$REPO_DIR/.env" | cut -d= -f2)"
fi
if [ -z "$DISCORD_ID" ]; then
  echo "Usage: $0 <discord_user_id>" >&2
  exit 1
fi

# Copy DB + WAL, checkpoint, clean
cp "$DB" "$TMP"
[ -f "$DB-wal" ] && cp "$DB-wal" "$TMP-wal"
[ -f "$DB-shm" ] && cp "$DB-shm" "$TMP-shm"

node -e "
const D = require('better-sqlite3');
const d = new D('$TMP');
const u = d.prepare('SELECT id FROM users WHERE discord_user_id = ?').get('$DISCORD_ID');
if (!u) { console.log('No user found for $DISCORD_ID'); d.close(); process.exit(0); }
const c = d.prepare('SELECT id, name FROM player_characters WHERE user_id = ?').get(u.id);
if (!c) { console.log('No character for user ' + u.id); d.close(); process.exit(0); }
// Disable FK enforcement so we can delete in any order (we know the
// data model and delete all related rows explicitly).
d.pragma('foreign_keys = OFF');

// Delete in dependency order: children before parents.
const tables = [
  'llm_calls',           // references actions (action_id)
  'npcs',                // may reference actions (created_by_action_id)
  'actions',             // references player_characters
  'items',               // references player_characters
  'feedback',            // references player_characters
  'bug_reports',         // references player_characters
  'player_characters',   // references users
];
for (const t of tables) {
  if (t === 'player_characters') {
    console.log(t + ': ' + d.prepare('DELETE FROM ' + t + ' WHERE id = ?').run(c.id).changes);
  } else if (t === 'npcs') {
    // NPCs reference actions, delete those created by this character's actions
    const actionIds = d.prepare('SELECT id FROM actions WHERE character_id = ?').all(c.id).map((r: { id: number }) => r.id);
    if (actionIds.length > 0) {
      console.log(t + ': ' + d.prepare('DELETE FROM ' + t + ' WHERE created_by_action_id IN (' + actionIds.join(',') + ')').run().changes);
    }
  } else if (t === 'llm_calls') {
    // llm_calls references actions (action_id)
    const actionIds = d.prepare('SELECT id FROM actions WHERE character_id = ?').all(c.id).map((r: { id: number }) => r.id);
    if (actionIds.length > 0) {
      console.log(t + ': ' + d.prepare('DELETE FROM ' + t + ' WHERE action_id IN (' + actionIds.join(',') + ')').run().changes);
    }
  } else {
    console.log(t + ': ' + d.prepare('DELETE FROM ' + t + ' WHERE character_id = ?').run(c.id).changes);
  }
}
d.prepare('DELETE FROM users WHERE id = ?').run(u.id);
d.pragma('wal_checkpoint(TRUNCATE)');
d.close();
console.log('Cleared ' + c.name + ' (' + u.id + ')');
"

# Replace originals (dir is 777 so rm works even if files owned by container user)
rm -f "$DB" "$DB-wal" "$DB-shm"
cp "$TMP" "$DB"
chmod 666 "$DB"
echo "DB replaced."
