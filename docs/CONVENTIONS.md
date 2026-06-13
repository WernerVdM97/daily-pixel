# Docs Conventions

How we keep a brainstorm-heavy repo from turning into slop. Read this before adding a doc.

The deal is simple: **bodies are free-form** (dump ideas however you like), but **every file carries strict frontmatter** and lives in the right folder. The frontmatter is what lets us tell a wild idea from a locked direction at a glance, and lets tools (and future-you) navigate.

---

## 1. Every file starts with frontmatter

Using `docs/templates/doc-template.md`;

```yaml
---
title: Human-readable title
status: spark            # spark | exploring | decided | superseded
domain: engine           # vision | game | engine | ui | spark
phase: mvp               # poc | mvp | mvp+ — when this is targeted for implementation
tags: [render, vault]    # free-form, lowercase, for cross-cutting search
related:                 # wikilinks to sibling docs
  - "[[world-state-projection]]"
# --- optional, only when they apply ---
supersedes: "[[old-doc]]"
superseded_by: "[[new-doc]]"
---
```

`title`, `status`, `domain` are **required**. `tags`, `phase`, and `related` are strongly encouraged. The `supersedes` / `superseded_by` pair appears only on docs involved in a replacement.

### `phase` — the implementation target

| phase | Meaning |
|---|---|
| `poc` | Essential for a short proof-of-concept. Ship or die. |
| `mvp` | Core game loop, needed before anyone plays for real. |
| `mvp+` | Polish, depth, and deferred features. Only after POC survives. |

`phase` is orthogonal to `status`. A doc can be `status: spark, phase: poc` (raw idea, but essential) or `status: exploring, phase: mvp+` (fleshed-out, but deferred).

That's the whole template. No required body sections — write the body in whatever shape the idea wants.

### Todo list flavours:

Where thematically applicable use:

- [ ] to-do
- [/] incomplete
- [x] done
- [-] canceled
- [x] forwarded
- [<] scheduling
- [?] question
- [!] important
- [*] star
- ["] quote
- [l] location
- [b] bookmark
- [i] information
- [S] savings
- [I] idea
- [p] pros
- [c] cons
- [u] up
- [d] down

to describe lists.

---

## 2. `status` — the maturity signal (lives here, never in the folder)

A doc only moves between folders once as it matures from a spark. Its maturity is further tagged in this one field.

| status | Meaning | Trust it to… |
|---|---|---|
| `spark` | Raw idea. May be half-baked, wrong, or contradict another spark. | …capture a thought. Don't build on it. |
| `exploring` | A real candidate direction, actively being fleshed out. Not locked. | …discuss and prototype against, knowing it may change. |
| `decided` | This **is** the direction. Build against it. | …implement. Changing it requires a decision record. |
| `superseded` | Kept for history. Points to what replaced it via `superseded_by`. | …understand why we moved on. Nothing else. |

**Rule:** to overturn a `decided` doc, write a `decisions/` record and flip the old doc to `superseded` — don't silently edit it into something new, and don't open a competing third doc.

---

## 3. `domain` — the folder

| Folder | Domain | Holds |
|---|---|---|
| `vision/` | `vision` | Mission, pillars, north star, goals, non-goals. The "why." |
| `game/` | `game` | Core loop, mechanics, economy, world, narrative design. |
| `engine/` | `engine` | Graph DB, render, simulation, LLM gateway, data model. The "how it runs." |
| `ui/` | `ui` | Discord UX, command flows, ASCII presentation, and `ui/mockups/`. |
| `decisions/` | — | Decision records (ADRs): cross-cutting trade-offs that have been resolved. |
| `sparks/` | `spark` | Design inbox. All docs live here during Phase 1 (design). Docs graduate to domain folders when they reach `status: exploring` or higher in Phase 2+. |

`domain` in frontmatter always matches the folder the file sits in.

---

## 4. The sparks → domain flow

1. New idea → drop it in `sparks/` with `status: spark`, `domain: spark`.
2. When it earns a clear domain and firm direction, **`git mv`** it into that folder and bump `status` to `exploring` (or `decided`).
3. When it becomes the direction → `status: decided`.

**During Phase 1 (design), all docs live in `sparks/`.** The domain folders (`vision/`, `game/`, `engine/`, `ui/`) are empty — reserved for Phase 2 when design crystallizes into implementation. This keeps the repo honest: we're designing, not pretending to have a codebase.

Sparks are allowed to be messy and to contradict each other. The other folders are not.

---

## 5. Decisions resolve conflicts (don't spawn a third doc)

When two docs disagree, or a trade-off gets settled, write a record in `decisions/`:

- State the **context**, the **options**, and the **choice** (with consequences).
- Flip any losing doc to `status: superseded` and set its `superseded_by`.
- Link the decision from the `related` of the docs it touches.

This is the single most important anti-slop habit: **contradictions become one decision, not two rival docs that quietly drift.**

---

## 6. Naming & links

- **Filenames:** `kebab-case.md`, descriptive, one topic per file. No dates in the name (that's git's job).
- **Links:** use Obsidian-style `[[doc-name]]` (filename, no path/extension) in `related` and prose — on-theme with the vault and resilient to moves. Plain relative links work too for GitHub rendering.
- **Assets:** images live in `docs/assets/`. Name them after the doc they support.

---

## 7. The index

`docs/README.md` is the **map of content** — the one place that lists every doc with its status. Add your new doc's line there when you create it. If it's not on the map, it's slop.
