# Docs Conventions

How we keep a brainstorm-heavy repo from turning into slop. Read this before adding a doc.

The deal is simple: **bodies are free-form** (dump ideas however you like), but **every file carries strict frontmatter** and lives in the right folder. The frontmatter is what lets us tell a wild idea from a locked direction at a glance, and lets tools (and future-you) navigate.

---

## 1. Every file starts with frontmatter

```yaml
---
title: Human-readable title
status: spark            # spark | exploring | decided | superseded
domain: engine           # vision | game | engine | ui
tags: [render, vault]    # free-form, lowercase, for cross-cutting search
related:                 # wikilinks to sibling docs
  - "[[world-state-projection]]"
# --- optional, only when they apply ---
supersedes: "[[old-doc]]"
superseded_by: "[[new-doc]]"
---
```

`title`, `status`, `domain` are **required**. `tags` and `related` are strongly encouraged. The `supersedes` / `superseded_by` pair appears only on docs involved in a replacement.

That's the whole template. No required body sections — write the body in whatever shape the idea wants.

---

## 2. `status` — the maturity signal (lives here, never in the folder)

A doc never moves between folders as it matures. Its maturity is this one field.

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
| `sparks/` | — | Unsorted inbox. Raw dumps that haven't earned a domain yet. |

`domain` in frontmatter always matches the folder the file sits in.

---

## 4. The sparks → domain flow

1. New idea, not sure where it belongs? → drop it in `sparks/` with `status: spark`.
2. When it earns a clear domain, **`git mv`** it into that folder and bump `status` to `exploring`.
3. When it becomes the direction → `status: decided`.

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
- **Assets:** images live in an `assets/` folder inside their domain (e.g. `engine/assets/`), or `ui/mockups/` for mockups. Name them after the doc they support.

---

## 7. The index

`docs/README.md` is the **map of content** — the one place that lists every doc with its status. Add your new doc's line there when you create it. If it's not on the map, it's slop.
