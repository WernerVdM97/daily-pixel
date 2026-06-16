This repo is the design vault for **The Warden's Oak**.

When creating or editing ANY doc under `docs/`, **read and follow** the conventions in
**[docs/CONVENTIONS.md](./docs/CONVENTIONS.md)** — most importantly:

- every doc carries frontmatter (`title`, `status`, `domain` required);
- it lives in the matching domain folder (`vision/ game/ engine/ ui/ decisions/ sparks/`);
- add its line to the map of content in [`docs/README.md`](./docs/README.md).
- see `docs/templates/doc-template`

Maturity is a frontmatter `status` (`spark → exploring → decided → superseded`), never the folder. Resolve conflicts with a `decisions/` record — don't spawn a rival doc.

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
4. **Cutting a release:**
   - Merge `dev` into `main` (`--no-ff`).
   - Bump the version in `VERSION`.
   - Add a changelog entry for the new version (promote `[Unreleased]` → `[0.x.y]` with today's date).
   - Tag the release commit (`git tag -a v0.x.y -m "..."`).
   - Push the tag (`git push origin v0.x.y`).
5. **Merge strategy:** `--no-ff` (no fast-forward) on all merges into `main` so the merge commits are explicit.

### Workflow

```
dev  ─── feature work ─── changelog ─── merge ─── feature work ───
                                      \               /
main ────────────────────────────────── v0.x.y ──────── tag
```

## Agent skills

Project-tailored agent skills live in [`agent/skills/`](./agent/skills/). Expect them to be manually invoked.

- **[`game-development/`](./agent/skills/game-development/SKILL.md)** — orchestrator (`SKILL.md`) routing to sub-skills: `game-design`, `game-audio`, `game-art-static`, `game-art-dynamic`, `multiplayer`.
