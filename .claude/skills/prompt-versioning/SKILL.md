---
name: prompt-versioning
description: How to version any LLM prompt in The Warden's Oak (decision, critic, and future families). Use when editing anything under assets/prompts/ or changing a *_VERSION constant in prompt-builder.ts.
allowed-tools: Read, Write, Edit, Glob, Grep
paths:
  - assets/prompts/**
  - src/llm/prompt-builder.ts
---

# Prompt Versioning

Every LLM prompt is versioned so historical `llm_calls`/`actions` rows stay attributable to the exact prompt that produced them. The same discipline applies to **all** prompt families — don't special-case the decision prompt.

## Layout

Each family lives in `assets/prompts/<family>/`, loaded once at boot in `src/llm/prompt-builder.ts` from the file matching its version constant, which is stamped on every row it produces:

| Family | Folder | Version constant | Versioned file | Stamped as |
|--------|--------|------------------|----------------|------------|
| Decision | `assets/prompts/decision-prompts/` | `PROMPT_VERSION` | `decision-<vN>.md` | `<vN>` |
| Critic | `assets/prompts/critic/` | `CRITIC_VERSION` | `critic-<vN>.md` | `critic-<vN>` |

New families follow the same shape: own folder, own `*_VERSION` constant, `<family>-<vN>.md` files, and a `current_source.md` mirror.

## Rules (every family)

1. **Never edit a published version in place** — copy `<family>-<old>.md` → `<family>-<new>.md`, edit the new file, and bump the matching `*_VERSION` constant in `prompt-builder.ts`. Keep the old files so past rows stay attributable.
2. **Always mirror the active file to `current_source.md`** in the same folder — keep it byte-identical to the version the constant points at. It's the canonical "current" mirror.
3. **Version constants are independent.** Bumping `PROMPT_VERSION` does not touch `CRITIC_VERSION`, and vice versa — change only the family you're editing.

## Set-based families

A family whose runtime unit spans several templates fired together for one outcome (e.g. a classify → decide → resolve pipeline) doesn't fit "one version, one file" — it needs a **versioned set**: a directory of templates that ships and is stamped as a unit ([[v12-prompt-set-versioning]]).

- **Layout — directory per set:** `assets/prompts/<family>/<vN>/{template-a,template-b,…}.md`. Every template in the directory belongs to that version; there is no cross-version mixing.
- **One set-version constant, derived per-call stamps.** A single `*_SET_VERSION` constant (e.g. `PROMPT_SET_VERSION`) names the set; never hand-maintain a version constant per template inside it — that breaks "the set is stamped together" and adds bookkeeping for nothing. Per-call telemetry stamps the *stage within the set* as `${version}/${template}` (e.g. `'v12/combat'`), derived by a small helper (`stampFor`), never a hardcoded string.
- **No `current_source.md` mirror.** The single-file mirror exists because "current" means one file; a set has no single active file, so the versioned directory itself *is* the canonical, immutable-once-published unit — don't add a mirror for it.
- **Never edit a published set in place** — same rule as single-file families, at the directory level: copy `<family>/<old>/` → `<family>/<new>/`, edit the new directory, bump the `*_SET_VERSION` constant. Keep old set directories so past rows stay attributable.
