---
title: "Code Review — Changes since PR #14 (24e67b9..47700ca)"
status: spark
domain: spark
phase: poc
tags: [code-review, poc-beta-release]
related:
  - "[[poc-action-ux-refinements]]"
  - "[[per-option-stat-and-ability-checks]]"
---

# Review: Changes since PR #14 (`24e67b9..47700ca`)

### Context

- **Total diff:** 80 files changed, +3299 / −535
- **Tests:** 460 passed (37 test files)
- **Status:** `poc-beta-release` branch, 22 commits since last PR

---

### :rotating_light: CRITICAL: Change size — split this PR

**3,299 lines added is ~30× the recommended maximum.** The code review skill says:

> ~100 lines changed → Good. ~300 lines → Acceptable. ~1000 lines → Too large. Split it.

This diff includes **at least 6 logical changes** that should be separate PRs:

| Slice | Files | Est. size |
|-------|-------|-----------|
| 1. `format.ts` + `images.ts` — Components V2 infrastructure + nav buttons | ~5 files | ~400 lines |
| 2. Join wizard rewrite: data-driven YAML + UI polish + Start Over | ~8 files | ~600 lines |
| 3. Per-option stat + ability checks (dc.ts, machine.ts, mutations.ts) | ~6 files | ~300 lines |
| 4. Decision screen restyle — DC display, insight colouring, quest path | ~4 files | ~300 lines |
| 5. Backpack rewrite — capacity grid + stat-grouped display | ~3 files | ~200 lines |
| 6. Nearby entities (look.ts + WorldEngineImpl changes) | ~5 files | ~200 lines |
| 7. `/hi` + location header restructure, day-job action tweaks | ~4 files | ~150 lines |
| 8. LLM gateway changes: per-option stat + SUCCESS reward validation | ~2 files | ~150 lines |
| 9. README + production deployment docs rewrite | ~4 files | ~200 lines |
| 10. Test files: 10 new tests, 5 test updates | ~10 files | ~400 lines |
| 11. Prompt file reorganization (decision-v5, decision-v6) | ~8 files | ~400 lines |

**Recommendation:** Split into at least 3-4 smaller PRs. The nav-button + Components V2 infrastructure is foundational and should go first, then the per-option-stat engine changes, then the UI polish, then the join rewrite.

---

### :white_check_mark: What's good

1. **Data-driven join wizard** — moving from hardcoded option arrays to YAML-loaded `CharDefs` is the right direction. The test `join-options.test.ts` that verifies every YAML option is offered is excellent.

2. **`computeItemBonus` fix** — removing `* item.quantity` from the bonus calculation is correct. Quantity shouldn't multiply modifier. The comment explaining why is clear.

3. **Components V2 infrastructure** (`format.ts`, `images.ts`) — clean separation of concerns. The `buildComponentPayload` function with separator splitting and nav-button appending is well-documented and tested.

4. **Per-option stat system** — the ability-check architecture (d20 + `computeRollBonus(stats, items, stat)`) is a significant gameplay improvement. The LLM sees item bonuses for all stats, letting it author per-option stat overrides.

5. **Passive-insight visual hints** — green-tinting achievable options is a great UX touch. The test coverage for `(WIS 2 → passive insight 12)` vs `(WIS -1 → passive insight 9)` is thorough.

6. **`modify_max_stamina`** — full mutation lifecycle (type, validation, application, clamping) implemented correctly. The clamp logic `Math.min(state.stamina, state.maxStamina)` is right.

7. **SUCCESS reward validation (Rule 4b)** — good LLM guardrail. Catches the anti-pattern of `done:true` with only negative health/stamina and no reward.

8. **Nearby entities in `/look`** — the `npcEmoji` class-based mapping and the PC/NPC split rendering are clean.

---

### :wrench: Required Changes

**1. `computeItemBonus` now conflicts with `computeRollBonus` naming**

The old `computeItemBonus` (item modifiers only) and the new `computeRollBonus` (ability score + item modifiers) have names that don't signal which is which. A reader scanning a call site can't tell if they're getting the right value.

Simplify: rename `computeItemBonus` to `itemStatModifier` and `computeRollBonus` to `abilityCheckBonus`.

```typescript
// dc.ts
export function itemStatModifier(items: ItemData[], stat: string): number {
  return items
    .filter(item => item.stat === stat)
    .reduce((sum, item) => sum + item.modifier, 0);
}

export function abilityCheckBonus(stats: StatBlock, items: ItemData[], stat: string): number {
  const abilityScore = (stats as unknown as Record<string, string>)[stat] ?? 0;
  return abilityScore + itemStatModifier(items, stat);
}
```

**2. `formatHiScreen` callback in `index.ts` duplicates action-handler logic**

The anonymous `renderHiScreen` closure on lines ~393-400 duplicates the nav-button/`buildComponentPayload` pattern. This is fine as a first pass, but the repetition with the `/hi` handler itself suggests a shared `renderScreen(userId, commandName)` helper.

**Optional/Consider:** Extract a small helper in `index.ts`:

```typescript
async function renderScreen(userId: string, commandName: string): Promise<unknown> {
  const handler = registry.get(commandName);
  if (!handler) return undefined;
  const result = await handler({ user: { id: userId } } as never);
  const char = engine.getCharacter(userId);
  const navButtons = char ? getNavButtons(char, commandName) : undefined;
  return buildComponentPayload(result, { ephemeral: true, navButtons });
}
```

This would also let the nav-button action handler share it instead of inlining the `/action` resume flow.

**3. `hi.ts` indentation regression**

The `formatCharacterHeader` function still uses mixed indentation — some lines have tabs, some spaces. The diff shows:

```typescript
// Line 51: 1 tab
const lines: string[] = [];
// Line 52: 1 tab
lines.push(`⚔️  **${char.name}** — ${char.class}`);
// Line 57: 1 tab + the stat function body has inconsistent indent
```

This should be cleaned up to consistent 2-space indentation per project convention.

**4. Magic number `BACKPACK_CAPACITY = 10` — confirmed correct, but check `stats.ts`**

The backpack capacity is exported as `BACKPACK_CAPACITY`. But there's no cross-reference when displaying stats — if the stat display also shows `(x/10)` for stamina, the same constant should be shared. Verify `stamina` display uses `maxStamina` (it does, per `hi.ts` diff :white_check_mark:). Good.

**5. `emojis.join(" ")` in backpack — potential Discord message length limit**

If a character has 10 filled slots, the emoji grid is 10 emoji. If somehow the grid exceeds 20+ emoji (e.g., future capacity increase), the message could truncate. Low risk now, but consider a wrapping strategy if capacity increases.

---

### Nits

**6. `escapeRegex` in `format.ts` — lower-case `s` vs `str`**

This is a style preference, but `escapeRegex` uses a very compact `s` parameter name that contrasts with the expressive names elsewhere in the file (`text`, `opts`, `contentComponents`). Rename to `str` for consistency.

**7. `npcEmoji` in `look.ts` — no emoji for default case**

The `return '🗣️'` default is fine, but there's no emoji mapping for `rogue`, `thief`, or `scout`. Consider adding a few more common archetypes.

**8. `formatCharacterHeader` in `hi.ts` — unused `_getScene` parameter**

```typescript
export function makeHiCommand(
  engine: WorldEngine,
  dayJobs: DayJobDef[],
  _getScene?: (discordUserId: string) => string,  // now unused
)
```

The underscore prefix signals intent, but if this parameter is truly dead, remove it and update callers. If it's kept for future use, add a comment explaining the planned usage.

---

### Code Simplification Opportunities

**9. `formatBackpack` group-by-stat pattern**

The stat grouping uses a manual `Record<string, ItemData[]>` with a magic key `'__utility__'`. This is reasonable as-is, but if the pattern appears elsewhere, extract a `groupBy` utility.

**10. `buildComponentPayload` type assertions**

The function casts from `unknown` to the precise union type at the end:

```typescript
return result as typeof result & {
  components: Array<...>;
};
```

**FYI:** This pattern is fragile — if you add a new component type, the cast won't catch it. Consider using proper discriminated unions on the component types instead of the broad cast. Not urgent, but worth noting for when the component system grows.

**11. `handleInteraction` in `join.ts` — the catch block**

```typescript
await i.followUp(...).catch(() => {});
await i.deleteReply().catch(() => {});
```

**FYI:** The `.catch(() => {})` pattern on `followUp` and `deleteReply` silently swallows errors. This is intentional (best-effort cleanup), but a comment explaining *why* these can fail (e.g., "followUp may fail if the interaction already timed out — discard") would help future readers.

---

### Coverage Assessment

```
Test Files  37 passed (37)
Tests       460 passed (460)
```

- New tests for: DC display, passive insight colouring, join YAML options, `buildComponentPayload`, `getNavButtons`, look entities, mutations validation
- Old tests preserved: all 37 test files pass

**Gap:** No test for the `renderHiScreen` path in `join.ts` — the success path where a wizard completes and the `followUp`+`deleteReply` dance happens is untested. This is a complex interaction with side effects (public announcement, ephemeral replacement).

**Gap:** No test for the `nav:action` handler — the button that spawns the day-job menu or resumes an action. This is a significant UX flow.

---

### Verdict

**Approve with changes requested.**

- **Critical:** Split this into smaller PRs before merging. 3,299 lines is un-reviewable as one unit.
- **Required #1:** Rename `computeItemBonus` → `itemStatModifier` and `computeRollBonus` → `abilityCheckBonus` for naming clarity.
- **Required #2:** Fix indentation in `hi.ts`.
- **Consider #3:** Extract shared `renderScreen` helper to avoid callback duplication.
- **Consider #4:** Add tests for the `renderHiScreen` and `nav:action` interaction paths.
- **Nits:** Dead `_getScene`, `escapeRegex` parameter name, missing rogue/thief emoji.
