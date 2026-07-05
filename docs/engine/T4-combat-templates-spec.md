---
title: "T4 — v12 combat prompt templates: spec handoff"
status: shipped
domain: engine
phase: poc
tags: [combat, engine, prompt, pipeline, thread-c, stage-3, templates, spec]
related: ["[[stage-3-combat-spine-plan]]", "[[prompt-v12-combat]]", "[[v12-prompt-set-versioning]]"]
---

# T4 — v12 combat prompt templates (spec handoff)

**Contract:** encode the C-a combat rules into the v12 combat prompt templates (decide + resolve success/failure) per the Stage 3 plan's Task 4. **Read `docs/engine/stage-3-combat-spine-plan.md` first** (the ratified decisions block, especially decision 3 "engine owns the numbers", and the "Task 4" section) and **`docs/game/prompt-v12-combat.md` §C-a** (the four prompt-level rules this task encodes). Then read the files listed below for grounding.

This task is **authoring only** — no runtime orchestrator consumes `loadPromptSet` yet (`src/llm/prompt-builder.ts:13-16`), so the templates are verified by prompt-set load + a content lint, NOT by a runtime path. Do not wire anything into the machine.

## Grounding reads

1. `assets/prompts/decision-prompts/v12/decide/combat.md` — the current combat decide template (v11-migration skeleton; you rewrite its body).
2. `assets/prompts/decision-prompts/v12/resolve/combat/success.md` and `.../failure.md` — the current combat resolve recipes (you rewrite these).
3. `assets/prompts/decision-prompts/v12/decide/BASE.md` and `.../resolve/BASE.md` — the shared rules your templates are appended to. Do NOT restate what BASE already says; only add or override combat-specific rules. Match the house style (heading shape, `### N.` numbered rules, terse imperative voice) of the sibling `travel.md` / `skill/success.md`.
4. `docs/game/prompt-v12-combat.md` — the §C-a rules (the authoritative source for what to encode).
5. `src/llm/pipeline/types.ts:51-65` — `PipelineDecideResult`, especially `combatEnemy?: { name: string; anchor: 'npc' | 'location' }`.
6. `src/engine/action/PipelineActionStateMachine.ts:300-345` — how the machine reads `combatEnemy` off the decide result and how the engine-authored HP mutations are injected around resolve (grounding for what the templates must NOT author).
7. `tests/llm/prompt-set-loader.test.ts` — the existing content-lint style; your new lint assertions live here.

## The four C-a rules to encode (`docs/game/prompt-v12-combat.md` §C-a)

### decide/combat.md (rewrite the body — keep the `## COMBAT-SPECIFIC RULES` H2 so the loader lint still matches)

1. **Danger keyed to location safety (replaces the fixed "every 3rd/4th decision" cadence).** In an `is_safe = 0` (unsafe/wilds) location an encounter is the *expectation*; in safe places (Oak, town) combat is *rare* and, when it happens (a tavern scuffle), **non-lethal** in tone. Combat is **never blocked by location** — a player can throw a punch anywhere; only dangerous places host *lethal* fights. There is no safety-precondition gate. Read the `## Scene` safety tag (`safe|unsafe`) for the danger level. Delete the old "roughly every 3rd or 4th decision" and "safe for 2+ recent actions" cadence rules.
2. **Physical, item-anchored per-round options.** Each round offers approaches tied to the player's gear + stats — *how* they fight is a build choice. At least one option must anchor to a specific weapon/item from `### Inventory` (strike with the sword, draw the bow, raise the shield). Keep this rule (it exists in the skeleton) but sharpen it and cross-reference the BASE stat-mix rule rather than restating it.
3. **`required: true` throughout; combat overrides "resolve in 2–3 beats."** An active fight is `required: true` for every beat — no clean Skip, only Bail (the engine appends the bail option; per BASE Rule 3 you never author a retreat/bail option yourself). Combat runs *several* rounds, each a real exchange — explicitly override any "wrap up in 2–3 beats" instinct. State that a fight continues (non-empty `decision`) until the enemy falls, the player bails, or the engine caps it — the decide stage does NOT decide when combat ends.
4. **Signal enemy identity + anchor on the first combat beat.** On the FIRST beat of a new fight, emit an optional top-level `combatEnemy` object so the engine can establish the `in_combat` scene-state edge: `{ "name": "<the foe's name>", "anchor": "npc" | "location" }`. Use `anchor: "npc"` for a **named NPC or boss** (must match a `[N#]` NPC in `### Present`); use `anchor: "location"` for **unnamed minions/wildlife** (a wolf, a boar). Omit `combatEnemy` on continuation rounds (the fight is already established). If omitted or unresolvable, the engine defaults to a location-anchored minion — so it is a hint, never a hard requirement. Document `combatEnemy` as an addition to the JSON contract (the field is camelCase, matching `distilledType`/`baseDc`).

### resolve/combat/success.md and resolve/combat/failure.md (rewrite both recipes)

**The engine owns every combat number (plan decision 3 — do NOT violate).** `enemyHp` and the player's core band HP delta are engine-authored and injected around resolve. The resolve stage authors **only ancillary** mutations and narrates the band the engine already decided.

- **NEVER author `modify_health`** in either combat resolve template — the player's combat damage (and the survive-at-1 floor) is the engine's band delta, injected separately. The current `failure.md` authors `modify_health -1 to -3`; that is a **double-damage bug** — remove it.
- **NEVER author `enemyHp` / `set_relation` / `update_relation` / any `in_combat` edge** — the engine owns the enemy's HP across rounds. (These mutation types are not in the resolve `MUTATION TYPES` menu anyway; state the prohibition explicitly so the model does not improvise.)
- **success.md** — a win. Author ancillary reward only: `add_item` (loot / trophy from the fallen), optionally `modify_wealth` (coin from the fallen), and `modify_stamina` -1 to -3 (exertion, even in victory). **Reward scales with the fight's difficulty** — a harder fight (higher `baseDc`, tougher foe) yields more loot / larger `modify_wealth`. BASE Rule 2a (nat-20 doubles the *reward*) still applies to the loot. State plainly: narrate the enemy's defeat and the band the engine decided; do not author the killing damage.
- **failure.md** — a loss (the player fell, or the fight was lost on the cap-derive). Author ancillary setbacks only: `remove_item` (broken weapon / dropped gear) OR `modify_wealth` loss, and `modify_stamina` -1 to -3 (exhaustion). **No `modify_health`** (engine-owned). BASE Rule 2a (nat-1 amplifies costs) still applies to those ancillary costs. Narrate the wound/defeat the engine's band already inflicted; do not author the HP loss.

Keep the recipe markers the loader lint matches: `COMBAT SUCCESS` in success.md, `COMBAT FAILURE` in failure.md, and the `## COMBAT-SPECIFIC RULES` H2 in decide/combat.md.

## Deliverables

1. Rewritten `assets/prompts/decision-prompts/v12/decide/combat.md`.
2. Rewritten `assets/prompts/decision-prompts/v12/resolve/combat/success.md`.
3. Rewritten `assets/prompts/decision-prompts/v12/resolve/combat/failure.md`.
4. New content-lint assertions in `tests/llm/prompt-set-loader.test.ts` (add a `describe('v12 combat template content — T4 C-a rules')` block) asserting the loaded combat templates encode the rules and, critically, do NOT author engine-owned numbers:
   - decide combat template mentions location safety as the danger lever and no longer contains the old cadence text (`does not match /every 3rd or 4th/i`).
   - decide combat template documents the `combatEnemy` field (contains `combatEnemy` and both `"npc"` and `"location"` anchor values).
   - both resolve combat templates do NOT contain `modify_health` and do NOT contain `enemyHp` / `set_relation` (assert absence — these are the engine-owned-number guards).
   - success template references difficulty-scaled reward; failure template references a cost that is not health (e.g. `remove_item` or `modify_wealth`).

## Scope fence — do NOT

- Do **not** cut a `v13` set or bump `PROMPT_SET_VERSION`. `v12` is unpublished scaffolding (no orchestrator consumes `loadPromptSet`; zero attributable rows exist), and the plan's Task 4 says "update the v12 combat templates" — edit `v12` in place.
- Do **not** touch `BASE.md` / `resolve/BASE.md` / any non-combat template, `prompt-builder.ts`, or any `src/` engine/machine code. Templates only.
- Do **not** add `modify_health`, `enemyHp`, or any relation mutation to the combat resolve templates.
- Do **not** wire templates into the machine or the sim (that is T5 / a later promotion).
- Do **not** restate BASE rules verbatim; only add/override combat-specific rules.

## Verification (run before returning; report exact numbers)

```bash
npx vitest run tests/llm/prompt-set-loader.test.ts   # your new lint block + existing asserts green
npm run typecheck                                     # clean
npm test -- --run                                     # full suite green — baseline 1131 passing
```

Report: the three rewritten template bodies (or a tight summary of each), the new test block, and the exact pass counts.
