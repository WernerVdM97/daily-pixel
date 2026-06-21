# db-backups — pulling & examining the prod DB

Read-only tooling for inspecting a snapshot of the production database
(`warden.db`, SQLite via `better-sqlite3`).

**The DB files are never committed.** Git keeps the helper scripts in this
folder (`*.mjs`, this README) and ignores the snapshots themselves
(`warden-*/`, `.latest`, `*.db*`). So you clone the repo, pull your own
snapshot, and the scripts find it.

> ⚠️ A snapshot contains **real player data** (Discord-linked characters,
> feedback, bug text). Don't commit it, don't share it.

---

## 1. Pull a snapshot

The prod DB lives on the container at `/home/bot/app/data/warden.db` and runs in
WAL mode, so grab all three files together for a consistent copy. This is a
pure `scp` — it **does not modify** the container.

```sh
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="db-backups/warden-$STAMP"
mkdir -p "$DEST"
for f in warden.db warden.db-wal warden.db-shm; do
  scp "root@192.168.0.242:/home/bot/app/data/$f" "$DEST/$f"
done
echo "$DEST" > db-backups/.latest   # optional pointer; scripts also auto-detect the newest
```

Each pull lands in its own timestamped folder, so old snapshots are kept side by
side. SQLite replays the WAL into the copy when first opened locally.

---

## 2. Which snapshot the scripts use

Every script resolves the snapshot in this order (first hit wins):

1. **CLI arg / `DB_SNAPSHOT` env** — a folder name under `db-backups/` (or an absolute path).
2. **`db-backups/.latest`** — the pointer written above, if present.
3. **Newest `db-backups/warden-*`** — most recent snapshot on disk.

```sh
node db-backups/probe.mjs                              # newest snapshot
node db-backups/probe.mjs warden-20260621-145324       # a specific one
DB_SNAPSHOT=warden-20260621-145324 node db-backups/q.mjs "SELECT * FROM meta"
```

All connections are opened **read-only** (`query_only = ON`) — the scripts
cannot mutate the snapshot, let alone prod.

---

## 3. The scripts

| Script | What it does |
|---|---|
| `q.mjs` | Ad-hoc query runner. `node db-backups/q.mjs "<SQL>"` prints rows as JSON. No arg → lists tables + row counts. |
| `probe.mjs` | Quick health read: table row counts, `meta` key/values, action & feedback time spans. Run this first. |
| `extract.mjs` | The findings dump: feedback & bug reports (with character names + dates), action-outcome distribution, LLM health (`parse_ok`/`tier`/`http_status`/errors), validation warnings, token & latency stats. |
| `correlate.mjs` | Cross-cuts by build: validation warnings & outcomes per `app_version`, the `done`/auto-resolve detail, timeouts, latency buckets, day-by-day engagement, per-character activity. |
| `_db.mjs` | Shared snapshot resolver + read-only `openDb()`. Imported by the others; not run directly. |

```sh
node db-backups/probe.mjs
node db-backups/extract.mjs
node db-backups/correlate.mjs
node db-backups/q.mjs "SELECT name, health, rolls_remaining FROM player_characters ORDER BY rolls_remaining"
```

These backed the report at
[`docs/sparks/prod-data-review-v0.2.3.md`](../docs/sparks/prod-data-review-v0.2.3.md)
— re-run them against a fresh snapshot to refresh those numbers.

---

## 4. Schema cheat-sheet

Canonical schema: [`src/db/schema.sql`](../src/db/schema.sql); evolution in
[`src/db/migrations/`](../src/db/migrations/). Tables most useful for analysis:

| Table | Notable columns |
|---|---|
| `feedback` / `bug_reports` | `character_id`, `text`, `created_at` (no status/version column — correlate `created_at` against `CHANGELOG.md`) |
| `actions` | `raw_input`, `type`, `outcome` (`success`/`failure`/`done`/`timed_out`/`bailed`/`skipped`), `final_dc`, `player_rolled`, `app_version`, `prompt_version`, `applied_mutations`, `narrative`, `created_at` |
| `llm_calls` | `action_id`, `prompt_version`, `model`, `tier` (0=primary,1=fallback), `parse_ok`, `validation_warnings`, `error`, `http_status`, `prompt/completion/total_tokens`, `reasoning_chars`, `latency_ms`, `finish_reason` |
| `player_characters` | `name`, `class`, `health`/`max_health`, `stamina`, `rolls_remaining`, `location`, `last_played_at`, `last_rested_day` |
| `meta` | key/value (`day_number`, `last_release_announced`, `llm_fallback_count`, …) |

> Tip: `actions.outcome = 'done'` means the action auto-resolved with **no
> roll** (`player_rolled` is null) — see the report for why that matters.
