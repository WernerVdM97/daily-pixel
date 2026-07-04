---
title: v12 prompt-set versioning
status: decided
domain: engine
phase: poc
tags: [prompt-versioning, thread-d, stage-0b]
related: ["[[prompt-separation-of-concerns]]", "[[prompt-v12-pipeline]]", "[[stage-0a-sim-harness-plan]]"]
---
_Stage 0b of the v12 critical path: extend the one-file-per-version prompt convention to a **versioned prompt set** (a directory of templates stamped together) so a pipeline outcome still traces to the exact set that produced it. Settles layout, the version-constant shape, and row-stamping **before** any template is authored (Thread D / Stage 1). This is scaffolding only — it does not touch the live `v11` path._

---

## Why

`PROMPT_VERSION = 'v11'` is a flat string that selects one file (`decision-v11.md`) and is stamped on every `actions`/`llm_calls` row. Thread D decomposes the monolith into a pipeline of templates (classify → per-`ActionCategory` decide → resolve), all firing within a single action. One string → one file no longer describes reality: an action now spans several templates, and telemetry must still attribute an outcome to the exact set and the exact stage within it. The versioning convention has to grow a **set** concept before templates are written on top of it.

## Decisions

### 1. Layout — subdirectory per stage

```
assets/prompts/decision-prompts/v12/
├── classify.md                        ← STUB (classifier prompt)
├── decide/
│   ├── BASE.md                        ← shared decide rules (optional; prepended by loader)
│   ├── phases/
│   │   ├── NEW_ACTION.md              ← NEW_ACTION phase rules (optional)
│   │   └── CONTINUE.md                ← CONTINUE phase rules (optional)
│   ├── combat.md
│   ├── travel.md
│   ├── social.md
│   ├── skill.md
│   ├── search.md
│   ├── rest.md
│   └── other.md
└── resolve/
    ├── BASE.md                        ← shared resolve rules (optional; prepended by loader)
    ├── combat/
    │   ├── success.md
    │   └── failure.md
    ├── travel/   {success,failure}.md
    ├── social/   {success,failure}.md
    ├── skill/    {success,failure}.md
    ├── search/   {success,failure}.md
    ├── rest/     {success,failure}.md
    └── other/    {success,failure}.md
```

`classify` is a reserved bookend name. Per-type **decide** templates live under `decide/`, named for their `ActionCategory` (`src/llm/LlmGateway.ts:48` — `combat · travel · social · skill · search · rest · other`). Per-type-per-verdict **resolve** templates live under `resolve/<category>/`, split into `success.md` and `failure.md`.

**Phase splitting (decide only):** `decide/phases/NEW_ACTION.md` and `decide/phases/CONTINUE.md` separate the opening-beat rules from the chaining-beat rules so the model sees only what's relevant to its current task. Both are optional — a set without phase files just uses the shared BASE.

**BASE files:** `decide/BASE.md` carries phase-agnostic rules shared by all decide templates; `resolve/BASE.md` carries rules shared by all resolve templates. Both are optional — a set without BASE files loads templates self-contained. BASE files live inside the set directory (not version-portable across sets): a `v13` set would have its own `v13/decide/BASE.md`.

`other.md` is included even though some paths don't use it: the classifier can emit `'other'`, so the decide map must be **total** over `ActionCategory` — an unmapped enum value would be a latent runtime gap. If Thread D decides `'other'` is handled specially (e.g. rejected at classify time), trim it then; a total map is the safe default now.

### 2. Version-constant shape — one set version, derived stamps

A single new constant names the set; per-call stamps are derived, never hand-maintained (no duplicated version bookkeeping):

```ts
export const PROMPT_SET_VERSION = 'v12';
// actions.prompt_version   → 'v12'                 (the set)
// llm_calls.prompt_version → 'v12/classify', 'v12/combat', 'v12/resolve/combat/success', …  (the stage)
```

`PROMPT_VERSION = 'v11'` stays as the **live** single-file decision prompt and is untouched by this stage — the engine has no pipeline orchestrator yet, so flipping it would break boot. Stage 1 migrates the engine onto the set and retires the legacy constant.

Independent per-template constants (`CLASSIFY_VERSION`, `RESOLVE_VERSION`, …) were rejected: they break "the set is stamped together" and add bookkeeping without buying anything at POC scope.

### 3. Row stamping — no migration

Both `actions.prompt_version` and `llm_calls.prompt_version` are free-form `TEXT` (`src/db/schema.sql:45,82`) and already carry mixed values (`'v11'`, `'critic-v1'`). Per-stage stamps like `'v12/classify'` need **no schema change**. Wiring the gateway to emit them is Stage 1's job (the calls don't fire until the orchestrator exists); this stage only defines the `stampFor` helper and the convention.

### 4. `current_source.md` mirror — N/A for sets

The single-file convention mirrors the active file to `current_source.md`. A set has no single active file, so set-based families **do not** use a `current_source.md` mirror: the versioned directory is the canonical, immutable-once-published unit. The `prompt-versioning` skill is updated to state this.

## Loader contract (what the Sonnet build implements)

In `src/llm/prompt-builder.ts`, factor the existing `readFileSync(...).trim()` boilerplate into one helper (the two current loaders reuse it — no duplication), then add:

```ts
export const PROMPT_SET_VERSION = 'v12';

/** Maximum decision beats per action. Injected into the user message on CONTINUE so the
 *  model knows how close it is to the engine's beat cap. */
export const MAX_DECISIONS_PER_ACTION = 2;

export interface ResolveTemplates {
  success: string;
  failure: string;
}

export interface DecideTemplates {
  newAction: string;
  continue: string;
}

export interface PromptSet {
  version: string;
  classify: string;
  resolve: Record<ActionCategory, ResolveTemplates>;
  decide: Record<ActionCategory, DecideTemplates>;
}

/** Load a full prompt set from decision-prompts/<version>/. Throws loud (fail-fast at boot)
 *  if any expected template file is missing — a partial set must never run.
 *
 *  Assembly order (decide): BASE.md → phases/<PHASE>.md → <category>.md
 *  Assembly order (resolve): BASE.md → <category>/<verdict>.md */
export function loadPromptSet(version?: string): PromptSet;

/** Derive the per-call telemetry stamp: `${version}/${template}` (e.g. 'v12/combat',
 *  'v12/resolve/combat/success'). */
export function stampFor(template: string, version?: string): string;
```

Each stub `.md` is a clear placeholder (e.g. `# v12 · classify (STUB)` + a line noting it's authored in Stage 1 and not yet wired) — the loader only reads text, so stubs load fine and let the loader + its tests be real now.

## Scope fence

In scope: the layout, the loader + `PromptSet` types + `MAX_DECISIONS_PER_ACTION` constant, the stub template files, loader tests, this record, the `prompt-versioning` skill update, and flipping the Stage 0b markers in [[prompt-separation-of-concerns]]. **Out of scope:** authoring any template content, wiring the gateway/orchestrator to use the set, and flipping the live `PROMPT_VERSION` — all Stage 1 (Thread D).

## Verification

- `loadPromptSet('v12')` returns all templates; `decide` has an entry for every `ActionCategory` with both `newAction` and `continue` phase variants; `resolve` has `success`/`failure` per category.
- Templates assemble in order: BASE → phase → type-specific (decide); BASE → verdict recipe (resolve).
- `stampFor` derives `v12/classify`, `v12/combat`, `v12/resolve/combat/success`, etc.
- A missing template file throws a clear error naming the file.
- `MAX_DECISIONS_PER_ACTION = 2` is a named constant injected into the CONTINUE user message so the model knows its pacing boundary.
- `npm run typecheck` clean; `npm test` green; the live `v11` path and all existing tests are unaffected (`1057` tests as of the phase-split merge).

---

_Open (Thread D): whether `'other'` is a real decide template or a classify-time special case; when to retire the legacy `PROMPT_VERSION`; per-`call_kind` vocabulary for the pipeline stages (`classify`/`decide`/`resolve`) vs today's `'decision'|'critic'`. See [[prompt-v12-pipeline]] §D._
