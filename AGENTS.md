This repo is the design vault for **The Warden's Oak**.

When creating or editing ANY doc under `docs/`, **read and follow** the conventions in
**[docs/CONVENTIONS.md](./docs/CONVENTIONS.md)** — most importantly:

- every doc carries frontmatter (`title`, `status`, `domain` required);
- it lives in the matching domain folder (`vision/ game/ engine/ ui/ decisions/ sparks/`);
- add its line to the map of content in [`docs/README.md`](./docs/README.md).
- see `docs/templates/doc-template`

Maturity is a frontmatter `status` (`spark → exploring → decided → superseded`), never the folder. Resolve conflicts with a `decisions/` record — don't spawn a rival doc.

## Agent skills

Project-tailored agent skills live in [`agent/skills/`](./agent/skills/). Expect them to be manually invoked.

- **[`game-development/`](./agent/skills/game-development/SKILL.md)** — orchestrator (`SKILL.md`) routing to sub-skills: `game-design`, `game-audio`, `game-art-static`, `game-art-dynamic`, `multiplayer`.
