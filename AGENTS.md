This repo is the source code for **The Warden's Oak**.

When creating or editing ANY files under `docs/`, **read and follow** the conventions in
**[docs/CONVENTIONS.md](./docs/CONVENTIONS.md)** — most importantly:

- every doc carries frontmatter (`title`, `status`, `domain` required);
- it lives in the matching domain folder (`vision/ game/ engine/ ui/ decisions/ sparks/`);
- add its line to the map of content in [`docs/README.md`](./docs/README.md).
- see `docs/templates/doc-template`
- **no manual line wrapping in prose** — write one logical paragraph as one line and let the editor soft-wrap. Hard-wrapping mid-paragraph (inserting newlines at ~80–95 cols) renders fine but fights Obsidian's editor, which treats one newline as a soft break and expects paragraph = line. Hard breaks belong only where markdown needs them (list items, headings, code fences, table rows).

Maturity is a frontmatter `status` (`spark → exploring → decided → superseded/shipped/nogo`), never the folder. Resolve conflicts with a `decisions/` record — don't spawn a rival doc.

---

## Git conventions

These rules apply to every agent working on this repo.

### Branch model

| Branch | Purpose |
|--------|---------|
| `main` | Production. Releases only. Protected — no direct commits. |
| `dev`  | Integration. All work lands here first. Changelog must be kept up to date. |

### Rules

1. **Never commit directly to `main`.** All changes land on `dev` first.
2. **`dev` must keep the changelog up to date.** Every merge into `dev` should either add to `[Unreleased]` or, when cutting a release, promote it to a versioned section.
3. **Hotfixes on `main` must be merged back into `dev`.** If `main` ever receives a direct hotfix (bypassing the normal flow), merge `main` back into `dev` immediately so `dev` doesn't diverge.
4. **Versioning — POC beta stays on `0.2.x`.** For the whole POC beta, **bump the patch only** (`0.2.2 → 0.2.3 → 0.2.4 → …`). Do **not** bump the minor (`0.3.x`) or major — `0.3.0` is reserved for the end of POC beta. `VERSION` holds the bare number (no `v`); tags and release-notes filenames carry the `v` prefix (`v0.2.x`).
5. **Cutting a release:**
   - Merge `dev` into `main` (`--no-ff`).
   - Bump the **patch** in `VERSION` (e.g. `0.2.2` → `0.2.3`).
   - Add a changelog entry for the new version (promote `[Unreleased]` → `[0.2.x]` with today's date).
   - Add player-facing release notes at `assets/release-notes/v0.2.x.yml` matching the new tag (see **Release-notes conventions** below).
   - Tag the release commit (`git tag -a v0.2.x -m "..."`).
   - Push the tag (`git push origin v0.2.x`).
6. **Merge strategy:** `--no-ff` (no fast-forward) on all merges into `main` so the merge commits are explicit.

### Workflow

```
dev  ─── feature work ─── changelog ─── merge ─── feature work ───
                                      \               /
main ────────────────────────────────── v0.x.y ──────── tag
```

## System prompt conventions

The LLM decision prompt is versioned: `assets/prompts/decision-prompts/decision-<version>.md`, selected by `PROMPT_VERSION` in `src/llm/prompt-builder.ts` (stamped on every action row for data mining).

When modifying the system prompt:

1. **Never edit a published version in place** — add a new `decision-v<N+1>.md` and bump `PROMPT_VERSION`, so historical action rows stay attributable to the prompt that produced them.
2. **Always copy the latest prompt to `current_source.md`** in the same folder. It is the canonical "current" mirror — keep it byte-identical to the active versioned file.

## Release-notes conventions

Player-facing release notes live in `assets/release-notes/v<tag>.yml` — **one file per release tag** (e.g. `v0.2.3.yml`). On boot, if the running tag (`v<VERSION>`) differs from the stored `last_release_announced` meta and a matching file exists, the bot posts the notes to the announcement channel with a **Request / Feedback** button, then stamps the meta so it fires exactly once per tag.

When cutting a release:

1. **Add a notes file matching the new tag** (`v0.2.x.yml`) with `tag`, `title`, and a non-empty `highlights` list (optional `date`, `notes`). No file → nothing is posted (and the meta is left untouched, so adding one later still fires on the next boot).
2. **Keep it non-technical.** Highlights are what's new and fun for players — not migrations, refactors, or internal plumbing. The changelog is the technical record; the notes file is the player's.
3. **The filename tag must match the git tag exactly** (`v` prefix included), or the announcement won't fire.

## Code comment conventions

Comments earn their keep by explaining **why**, not restating **what**. Apply this to every code change:

1. **No echo comments.** Delete any comment that just narrates the next line (`// loop over users` above an obvious loop). The code already says it.
2. **Keep the why, cut the fluff.** Preserve genuine rationale — non-obvious decisions, edge cases, error-code meanings, idempotency/ordering caveats, API quirks, gotchas — but write it tight. One line beats six whenever the substance survives.
3. **JSDoc adds info or goes.** Keep `@param`/`@returns` only when they say more than the signature already does. Collapse padded doc blocks to 1-2 lines.
4. **Section dividers stay short.** `// ── Config ──`-style navigation markers are fine; keep them minimal.
5. **Verbose only where necessary.** A long comment is justified when it carries load-bearing rationale that would be lost otherwise — not as default narration.

## Agent skills

Project-tailored agent skills live in [`agent/skills/`](./agent/skills/). Expect them to be manually invoked.

- **[`game-development/`](./agent/skills/game-development/SKILL.md)** — orchestrator (`SKILL.md`) routing to sub-skills: `game-design`, `game-audio`, `game-art-static`, `game-art-dynamic`, `multiplayer`.
