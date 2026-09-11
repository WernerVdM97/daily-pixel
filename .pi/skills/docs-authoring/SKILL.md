---
name: docs-authoring
description: Conventions for creating or editing docs in The Warden's Oak (frontmatter, domain folders, the map of content, no manual line-wrapping). Use whenever you create or edit any file under docs/.
allowed-tools: Read, Write, Edit, Glob, Grep
paths:
  - docs/**
---

# Docs Authoring

The full rules live in **[docs/CONVENTIONS.md](../../../docs/CONVENTIONS.md)** — read it before adding or editing a doc. The essentials:

- Every doc carries frontmatter (`title`, `status`, `domain` required) — use `docs/templates/doc-template.md`.
- It lives in the matching domain folder (`vision/ game/ engine/ ui/ decisions/ sparks/`).
- Add its line to the map of content in [`docs/README.md`](../../../docs/README.md).
- **No manual line wrapping in prose** — write one logical paragraph as one line and let the editor soft-wrap. Hard-wrapping mid-paragraph renders fine but fights Obsidian, which treats one newline as a soft break and expects paragraph = line. Hard breaks belong only where markdown needs them (list items, headings, code fences, table rows).

Maturity is a frontmatter `status` (`spark → exploring → decided → superseded/shipped/nogo`), never the folder. Resolve conflicts with a `decisions/` record — don't spawn a rival doc.
