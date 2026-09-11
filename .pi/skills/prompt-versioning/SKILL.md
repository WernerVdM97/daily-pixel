---
name: prompt-versioning
description: How to version any LLM prompt in The Warden's Oak (decision, critic, agent-player, and future families). Use when editing anything under assets/prompts/ or changing a *_VERSION constant in prompt-builder.ts or src/agent/.
allowed-tools: Read, Write, Edit, Glob, Grep
paths:
  - assets/prompts/**
  - src/llm/prompt-builder.ts
  - src/agent/agentPrompt.ts
  - src/agent/criticPrompt.ts
---

# Prompt Versioning

Every LLM prompt is versioned so historical `llm_calls`/`actions` rows stay attributable to the exact prompt that produced them. The same discipline applies to **all** prompt families — don't special-case the decision prompt.

## Layout

Each family lives in `assets/prompts/<family>/`, loaded from the file matching its version constant, which is stamped on every row it produces. The owning module is the module that reads the prompt, not necessarily `prompt-builder.ts`:

| Family | Folder | Version constant | Owning module | Versioned file | Stamped as |
|--------|--------|------------------|---------------|----------------|------------|
| Decision | `assets/prompts/decision-prompts/` | `PROMPT_VERSION` | `src/llm/prompt-builder.ts` | `decision-<vN>.md` | `<vN>` |
| Critic | `assets/prompts/critic/` | `CRITIC_VERSION` | `src/llm/prompt-builder.ts` | `critic-<vN>.md` | `critic-<vN>` |
| Agent brain | `assets/prompts/agent-player/` | `AGENT_PLAYER_VERSION` | `src/agent/agentPrompt.ts` | `agent-<vN>.md` | `agent-<vN>` |
| Playtest critic | `assets/prompts/agent-critic/` | `AGENT_CRITIC_VERSION` | `src/agent/criticPrompt.ts` | `agent-critic-<vN>.md` | `agent-critic-<vN>` |

New families follow the same shape: own folder, own `*_VERSION` constant, `<family>-<vN>.md` files, and a `current_source.md` mirror (single-file) or a `current_source/` directory mirror (set-based — see below).

**Where a version constant lives.** The two `src/llm/prompt-builder.ts` families load eagerly at module scope and are boot-critical for the live bot. The two `src/agent/` families belong to the opt-in agent-player QA adapter (JSON-seam DA-5), which core LLM code must never depend on, so they own their constants and load lazily at gateway construction. Putting them in `prompt-builder.ts` would make a missing harness asset a production boot failure for a path prod never runs. Rules 1-3 below are location-agnostic and bind every family equally. Note the agent brain's files are `agent-<vN>.md`, not `agent-player-<vN>.md`; renaming them would decouple the filename from rows already stamped `agent-v1`, so the divergence stands deliberately.

## Rules (every family)

1. **Never edit a published version in place** — copy `<family>-<old>.md` → `<family>-<new>.md`, edit the new file, and bump the matching `*_VERSION` constant in the family's owning module (see the Layout table). Keep the old files so past rows stay attributable.
2. **Always mirror the active file to `current_source.md`** in the same folder — keep it byte-identical to the version the constant points at. It's the canonical "current" mirror.
3. **Version constants are independent.** Bumping `PROMPT_VERSION` does not touch `CRITIC_VERSION`, and vice versa — change only the family you're editing.

## Set-based families

A family whose runtime unit spans several templates fired together for one outcome (e.g. a classify → decide → resolve pipeline) doesn't fit "one version, one file" — it needs a **versioned set**: a directory of templates that ships and is stamped as a unit ([[v12-prompt-set-versioning]]).

- **Layout — directory per set:** `assets/prompts/<family>/<vN>/{template-a,template-b,…}.md`. Every template in the directory belongs to that version; there is no cross-version mixing.
- **One set-version constant, derived per-call stamps.** A single `*_SET_VERSION` constant (e.g. `PROMPT_SET_VERSION`) names the set; never hand-maintain a version constant per template inside it — that breaks "the set is stamped together" and adds bookkeeping for nothing. Per-call telemetry stamps the *stage within the set* as `${version}/${template}` (e.g. `'v12/combat'`), derived by a small helper (`stampFor`), never a hardcoded string.
- **Mirror the active set to a `current_source/` directory.** Generalises the single-file `current_source.md` rule to a set: keep `assets/prompts/<family>/current_source/` byte-identical to the version directory the `*_SET_VERSION` constant points at, so `current_source/` is always the canonical "current" set no matter what the active version is named. Re-sync it whenever the active set changes.
- **Never edit a *published* set in place** — once a set has produced attributable rows you must preserve (it's live in prod / past the cutover), copy `<family>/<old>/` → `<family>/<new>/`, edit the new directory, bump the `*_SET_VERSION` constant, and re-point `current_source/` at the new version. Keep old set directories so past rows stay attributable. A set still *in development* (pre-cutover, its only rows in a dev DB that gets wiped) may be edited in place — just keep `current_source/` in sync.
