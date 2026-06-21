---
title: YAML Asset Schemas & Test Coverage
status: spark
domain: spark
phase: poc
tags: [testing, assets, yaml, validation, schema, char-creation, release-notes]
related:
  - "[[polish-pass-v0.2.4]]"
  - "[[prod-data-review-v0.2.3]]"
  - "[[handover-code-review-post-pr14]]"
---

Every gameplay constant the bot ships — classes, backgrounds, races, alignments, day-jobs, item-sets, release-notes — is a YAML file loaded through `src/assets/yaml-loader.ts` and then **cast (`as`) into a type with no runtime check**. The loader validates *syntax and array-shape only*; nothing asserts an entry actually carries the fields its consumer reads. This spark defines a **canonical template per asset type** and a **test layer that validates the real files against it** — so a malformed asset fails loudly in CI instead of silently at a player.

> **Motivating proof:** `backgrounds.yml` has **5** entries missing a stat key (Farmstead·Temple-Raised·Urchin·Entertainer·Scout), `computeStats` sums them unguarded → `NaN` → persisted as `null`. **5 of 8 live prod characters already have a `null` ability score** (Flikker's `wisdom`, etc.). A manual sweep ([[polish-pass-v0.2.4]] §B1) counted **4** and missed Entertainer — the exact failure mode automated validation removes. *This spark is the guardrail; the data fix itself stays with polish §B1.*

> **Division of labour — disjoint from the other two sparks.**
> - **This spark owns:** a new validation module (`src/assets/asset-schemas.ts`) and new tests under `tests/assets/`, plus the templates below. It **absorbs/expands [[polish-pass-v0.2.4]] §B7** (the "loader does no completeness check" nit) into a systematic layer.
> - **Defers to [[polish-pass-v0.2.4]] §B1:** the `backgrounds.yml` *data* edit. The repair of the 5 already-corrupted live characters is a **one-off scriptfix, not a migration** — see "Repairing the corrupted live characters" below.
> - **Does NOT touch:** mock-fixture fidelity (polish §B8/B9), UI-handler tests (polish §C1–C3), or anything in [[prod-data-review-v0.2.3]] (resolution/prompt domain). No file overlap.

---

## Per-asset templates (the canonical shape)

Shared enum: **`STAT ∈ {physical, wisdom, intelligence, charisma}`**. All `modifiers` blocks must carry **all four** keys, integer-valued. `assets/char-creation/*.yml` are **arrays**; `release-notes/<tag>.yml` is a **single object** (loaded by its own `loadReleaseNotes`, not `loadYamlFile`).

```yaml
# classes.yml · backgrounds.yml · races.yml  — identical shape
- name: string                 # required, unique within file
  description: string          # required, non-empty
  modifiers: { physical: int, wisdom: int, intelligence: int, charisma: int }   # all 4 required

# alignments.yml
- name: string                 # required, unique (9 entries)
  axis: [law, moral]           # law ∈ {lawful,neutral,chaotic}, moral ∈ {good,neutral,evil}; combo unique
  description: string          # required

# day-jobs.yml
- name: string                 # required, unique
  depends_on: [STAT, ...]      # required, non-empty, each ∈ STAT
  base_income: int             # required, >= 0
  workplace_location: string?  # null (Wanderer) OR a seeded location name (migrate.ts seedLocations)
  description: string
  actions:                     # required, non-empty
    - { label: string, income: int>=0, hook: string }

# item-sets.yml
- name: string                 # required, unique
  description: string
  for_classes: [string, ...]   # required, each ∈ classes.yml names
  items:                       # required, non-empty
    - { name: string, emoji: string, stat: STAT, modifier: int, quantity?: int>=1 }

# release-notes/<tag>.yml  (single object)
tag: string                    # should equal "<filename without .yml>"
title: string                  # required, non-empty
date: string?                  # optional
highlights: [string, ...]      # required, non-empty
notes: string?                 # optional
```

These templates are authoritative; the commented headers already in each file should be kept in sync with them (or generated from the schema module).

---

## Test plan

The current suite tests the *generic loader* (`yaml-loader.test.ts`, synthetic data) and *display fields* (`join-options.test.ts`) — it never asserts the real assets' data integrity. Add:

- [ ] **T1 · Real-file schema validation.** For every shipped asset file, load and validate against its template above. Replaces the synthetic-only coverage. Catches missing/extra/mistyped fields on the actual files.
- [ ] **T2 · Modifier completeness.** Every `classes`/`backgrounds`/`races` entry has all four `STAT` keys, integer-valued. *(Catches all 5 broken backgrounds — the one a human count missed included.)*
- [ ] **T3 · `computeStats` finite round-trip (the killer test).** For **every** `class × background × race` combination, assert all four resulting stats are finite integers. One loop turns the silent-`NaN` class of bug into a red test.
- [ ] **T4 · Cross-file integrity.**
  - [I] `item-sets.for_classes` ⊆ class names, **and every class has ≥ 1 kit** (no class can finish `/join` kit-less).
  - [I] `item.stat ∈ STAT`; `item.modifier` integer; `quantity ≥ 1` when present.
  - [I] `day-jobs.depends_on ⊆ STAT`; `workplace_location` is `null` or a **seeded location name** — locks the invariant [[polish-pass-v0.2.4]] verified as currently-true so it can't silently break.
  - [I] `alignments.axis` values legal; 9 unique law×moral combos.
- [ ] **T5 · release-notes sweep.** Validate **every** file in `assets/release-notes/`, not just `v0.2.3` (a future malformed file currently degrades to a silent "no notes" at boot — `loadReleaseNotes` warns but nothing tests it). Assert `tag` matches the filename.
- [x] **Keep:** `join-options.test.ts` (every YAML option surfaces with non-empty label/description/emoji) — fold it under this umbrella rather than duplicate.

---

## Related suggestions

- [I] **A typed validate-on-load helper.** Add `loadAndValidate<T>(file, schema): T[]` over `loadYamlFile`, used at boot in `loadCharCreationAssets()`. On a bad entry it throws with **file + entry index + field name** — so a future omission crashes boot loudly (and the deploy `tsc`/test gate catches it) instead of producing a `null` stat. Removes every `as` cast in `index.ts`.
- [I] **Single source of truth.** Put the schemas in one `src/assets/asset-schemas.ts`; both the runtime validator (above) and the tests import them, and the templates in this doc derive from them.
- [?] **Dependency call:** hand-roll the validators (zero new deps, fine for 6 small schemas) **or** adopt a tiny schema lib (e.g. zod) for richer messages. POC-default: hand-roll. Decide before building.
- [I] **Golden count snapshot.** A test asserting the number of entries per file, so adding/removing an option is a deliberate, reviewed diff rather than an accident.
- [I] **CI:** these are plain `vitest` tests — they run in the existing `test` gate (`.github`), no new pipeline needed.
- [-] **Out of scope:** mock-fixture drift (polish §B8/B9); UI-flow tests (polish §C1–C3).

---

## Repairing the corrupted live characters (scriptfix, not migration)

5 of 8 prod characters already carry a `null` ability score. The repair is a **one-off scriptfix** — `scripts/fix-null-stats.mjs` — deliberately *not* a migration:

- [p] A fresh DB built from corrected assets never has the bug, so a migration would be a permanent no-op that just clutters the `schema_migrations` ledger. This patches existing rows on one live DB — exactly what a hand-run script is for.
- [I] The script recomputes each character's full stat block from `(class, upbringing, race)` using `StatComputer`'s rule **but defaulting any missing modifier key to 0**, so it is correct **even before** the §B1 YAML edit lands. It only writes rows whose stored stats differ, so it's idempotent and leaves correct characters untouched.
- [I] **Dry-run by default** (writes nothing; prints the diff). Verified against the read-only prod snapshot — it would set: Oom `int 0`, Flikker `wis 1`, UlrichTheShort `int 0`, SirAlexTheBrave `int 3`, UlrichTheTall `int 1`.
- [x] **Applied to prod 2026-06-21** (bot left running). Fresh backup taken first (`db-backups/warden-20260621-172625/`), then `--apply` against `/home/bot/app/data/warden.db`: 5 rows updated (Oom `int 0`, Flikker `wis 1`, UlrichTheShort `int 0`, SirAlexTheBrave `int 3`, UlrichTheTall `int 1`). Idempotency re-check returned 0; no `null` stats remain. The script was staged transiently and removed after (it lives in the repo at `scripts/fix-null-stats.mjs`). *Note: §B1's YAML edit is still pending — until it lands, a newly-created character picking one of the 5 backgrounds will be corrupted again. Re-running this script is safe and idempotent.*

---

## Suggested order

1. [ ] **T3 + T2** — the finite round-trip and completeness checks. Highest value; would have caught the live corruption. Pairs with polish §B1 landing the data fix (red → green).
2. [ ] **`asset-schemas.ts` + T1** — the schema module and real-file validation; the foundation the rest import.
3. [ ] **T4** — cross-file integrity (kit coverage, workplace locations, stat enums).
4. [ ] **`loadAndValidate` at boot** — fail-fast wiring; drop the `as` casts.
5. [ ] **T5 + golden counts** — release-notes sweep and snapshot guards.
