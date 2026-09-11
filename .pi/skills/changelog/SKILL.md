---
name: changelog
description: How to write CHANGELOG.md entries for The Warden's Oak — scannable one-liners, grouped by kind. Use whenever you add to or edit CHANGELOG.md (every merge into dev should touch it).
allowed-tools: Read, Edit, Glob, Grep
paths:
  - CHANGELOG.md
---

# Changelog

`CHANGELOG.md` entries earn their keep by being **scannable**, not exhaustive — one tight line per change, like a good commit subject. The PR, commit, and any `docs/decisions/` record hold the full story; the changelog is the index.

**CHANGELOGS SHOULD BE BRIEF AND TO THE POINT.** Prefer a one- or two-sentence summary that refers to a commit for further reading, instead of whole paragraphs.

1. **One bullet, one line.** Lead with a **bold subject** naming the change, then an em-dash and the gist in a sentence or two. If you need a paragraph, the detail belongs in the PR/decision doc — link it, don't inline it.
2. **Say what changed and why it matters, not how it's wired.** Skip the play-by-play of helpers, call sites, and internal flow. Name the new column/env var/method when a reader needs it to act, not to narrate the diff.
3. **Cut hedging and restatement.** No "previously…/instead of…" retelling of the old behaviour unless the contrast is the point. One clause of rationale beats six.
4. **Group by Keep-a-Changelog kind** (`Added`/`Changed`/`Fixed`/`Chore`/`Internal`) and keep each bullet in its right group — don't bury a fix inside an Added blurb.

**Verbose is justified only when the reader must *act* on the detail**, not as default narration. Keep the specifics for: required Discord permissions or env vars to set; migrations and schema changes (column names, idempotency, no-op-on-existing-DB caveats); breaking changes and contract shifts; security fixes; anything with an ordering/idempotency gotcha that bites if missed. When in doubt, ask "would a reader skimming the release have to do something because of this line?" — if yes, spell it out; if no, one line.
