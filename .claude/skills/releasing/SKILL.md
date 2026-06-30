---
name: releasing
description: Branch model, POC-beta versioning, and the full cut-a-release procedure for The Warden's Oak. Use when committing/branching, merging dev→main, bumping VERSION, writing release notes, or tagging a release.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Releasing

Git workflow, versioning, and the release procedure. The always-on guardrails (never commit/push `main`; all work lands on `dev` first) live in `AGENTS.md` — this skill is the full procedure behind them.

## Branch model

| Branch | Purpose |
|--------|---------|
| `main` | Production. Releases only. Protected — no direct commits. |
| `dev`  | Integration. All work lands here first. Changelog must be kept up to date. |

## Rules

1. **Never commit directly to `main`.** All changes land on `dev` first.
2. **`dev` must keep the changelog up to date.** Every merge into `dev` should either add to `[Unreleased]` or, when cutting a release, promote it to a versioned section. (See the `changelog` skill for entry style.)
3. **Hotfixes on `main` must be merged back into `dev`.** If `main` ever receives a direct hotfix (bypassing the normal flow), merge `main` back into `dev` immediately so `dev` doesn't diverge.
4. **Versioning — POC beta stays on `0.2.x`.** For the whole POC beta, **bump the patch only** (`0.2.2 → 0.2.3 → 0.2.4 → …`). Do **not** bump the minor (`0.3.x`) or major — `0.3.0` is reserved for the end of POC beta. `VERSION` holds the bare number (no `v`); tags and release-notes filenames carry the `v` prefix (`v0.2.x`).
5. **Merge strategy:** `--no-ff` (no fast-forward) on all merges into `main` so the merge commits are explicit.

## Cutting a release

1. Merge `dev` into `main` (`--no-ff`).
2. Bump the **patch** in `VERSION` (e.g. `0.2.2` → `0.2.3`).
3. Add a changelog entry for the new version (promote `[Unreleased]` → `[0.2.x]` with today's date).
4. Add player-facing release notes at `assets/release-notes/v0.2.x.yml` matching the new tag (see below).
5. Tag the release commit (`git tag -a v0.2.x -m "..."`).
6. Push the tag (`git push origin v0.2.x`).

```
dev  ─── feature work ─── changelog ─── merge ─── feature work ───
                                      \               /
main ────────────────────────────────── v0.x.y ──────── tag
```

## Release-notes conventions

Player-facing release notes live in `assets/release-notes/v<tag>.yml` — **one file per release tag** (e.g. `v0.2.3.yml`). On boot, if the running tag (`v<VERSION>`) differs from the stored `last_release_announced` meta and a matching file exists, the bot posts the notes to the announcement channel with a **Request / Feedback** button, then stamps the meta so it fires exactly once per tag.

1. **Add a notes file matching the new tag** (`v0.2.x.yml`) with `tag`, `title`, and a non-empty `highlights` list (optional `date`, `notes`). No file → nothing is posted (and the meta is left untouched, so adding one later still fires on the next boot).
2. **Keep it non-technical.** Highlights are what's new and fun for players — not migrations, refactors, or internal plumbing. The changelog is the technical record; the notes file is the player's.
3. **The filename tag must match the git tag exactly** (`v` prefix included), or the announcement won't fire.
