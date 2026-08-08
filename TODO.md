# TODO

## ⏭️ RESUME HERE - JSON seam arc: **M9 in flight — M9.0 DONE, M9.1 build committed + reviewed with THREE ACCEPTED FIXES PENDING (slice not closed), M9.2 not started** (M8 COMPLETE 2026-08-06 + M8.5 smoke-run tooling COMPLETE 2026-08-06; M9 build plan lead-settled 2026-08-08; last touched 2026-08-08)

**M9.1 (the seam gaps) — build `e9228cc`, review sound-as-is, FIXES PENDING; the session stopped on the owner's instruction (usage).** The four gaps closed: the `collapse` fact (unconditional on outcome envelopes with a post-action char — the `restUnsafe` precedent, so the collapse transition predicate stays single-sourced in `collapse.ts`), the divine-intervention arm (a tenth error code `'divine-intervention'`, not a new ViewState screen — the `empty-action` precedent; its two dispatcher paint sites are compiler-forced and land with it, and the harness's `mapError` gains the arm), the two slash feedback surfaces (router-side character guard, `bug.submit` surface optional so today's caller is untouched), and the `getNavButtons` widening. 100 files / 2089 tests green, typecheck clean. Both declared churn classes verified independently and exactly: the protocol corpus gains `facts.collapse` on seq 15 + 20 only, `dispatch-oracle.test.ts.snap` gains the two divine transcripts as pure additions, the other three oracle snapshots byte-untouched. **Recorded behaviour change:** a divine result on the modal + day-job paths no longer paints as a ✅ outcome with buttons and no longer broadcasts, and the agent counts a refunded roll as a stumble rather than a completed action — the fidelity loss it has carried since M6. **Three accepted review fixes are the slice's next commit** (build and review-fix stay separate): the `collapse` mapping test is tautological and must source the fact from a real `GameRouter` envelope, `mapError`'s divine arm has no test, and `bug.submit`'s optional-surface validator has no negative space. Then the slice checkbox + execution state close M9.1 (the changelog line is already in `[Unreleased]`). Full detail, the two dropped nits and the new `migrate.test.ts` `--sequence.shuffle` flake watch item: `docs/engine/json-seam-protocol.md` § Execution state tail.

**M9.0 done 2026-08-08** (`c4f82cc` + review fix `a53f315`, review sound-as-is): `tests/discord/action-oracle.test.ts` pins 18 dispatch-level transcripts over the slash `/action` arm and the `/feedback` + `/bug` arms — the last un-netted surfaces before the port. 100 files / 2037 tests green, typecheck clean, the three existing oracle snapshots byte-unchanged. Three findings the M9.2 checklist inherits: **DC-M9.10 churn class 1 is vacuous** (charless `/action` is gated and reroutes to the join wizard, so the handler's "yet" copy is dead at dispatch level), **three churn classes DC-M9.10 does not declare are now pinned** ("⏳ Starting…" vs the router's "Thinking…", the unclipped >280-char echo, and the `stampLastPlayed` bare `/action` does not perform but `menu.open` will) and stay amendment candidates for M9.2 to settle, and **M9.2 owes a verification that `actionType`/`combatEnemyName`/`combatEnemyCondition` still thread through the crossing** (unpinned arc-wide — the M1 oracle omits them too). Also open for M9.2's checklist: where `commands/feedback.ts` / `commands/bug.ts` rewire onto the DC-M9.5 surfaces (the slice sequence never says). Recorded, not fixed: `commands/action.ts`:108-115's inner rolls guard is dead code (the top guard at :67 already covers it) — don't preserve it byte-for-byte at M9.2.

**M9 build plan landed 2026-08-08** (`docs/engine/json-seam-protocol.md` § M9 build plan): recon, ten design calls (DC-M9.1 to DC-M9.10), five slices. Order binding: **M9.0** action-paths oracle (test-only, the M1-before-M3 law: the M1 oracle covers the customId action paths but NOT the slash `/action` arm) → **M9.1** seam gaps (the `collapse` fact, the divine-intervention arm, two feedback surfaces, the `getNavButtons` widening) → **M9.2** slash `/action` crossing → **M9.3** dispatcher rewrite → **M9.4** structural check + layering moves. Three recon findings worth knowing before starting: `viewPublic` is NOT a protocol gap (RA-6 aliased it to `viewPrivate`), `announceCollapse`'s prev/updated vitals ARE one (the `restUnsafe` precedent applies), and **divine intervention exists only in `commands/action.ts`** so everything already through the seam (incl. the agent harness since M6) renders it as an ordinary outcome. **DC-M9.7 SIGNED OFF by the owner 2026-08-08** — the profanity guard moves behind the seam, closing a real gap (slash `/action <text>` is unfiltered today, only the modal is guarded) at the cost of a recorded behaviour change on the slash path. M9.3 builds the move; the guard's word list and verdict do not change.

**Baseline repair 2026-08-08 (`1fc4502`).** The M9 pre-flight run was RED: the `character.create` contract block asserts the weekday "Daily Work" copy but pinned no clock, and its `created` arm returns the first-day `/hi` view, which branches on `isWeekend()`. Green on the Thursday it landed, red every Saturday and Sunday. Test-only fix mirroring the sibling `hi.open` block's existing pin. **This is the first live bite of the SF3 same-weekday-class caveat** M8.5 recorded (logged there as a constraint on real-backend corpus recordings; the actual defect was an unpinned contract test). Three other weekday-matching suites audited, all false positives. Suite back to 99 files / 2019 tests green, typecheck clean.

**Read first:** [`docs/engine/json-seam-handover-m7-m8.md`](./docs/engine/json-seam-handover-m7-m8.md) (the M7/M8 lead prompt — the law, gates, execution rules), then the canonical arc spec [`docs/engine/json-seam-protocol.md`](./docs/engine/json-seam-protocol.md) (§ M8 milestone + § Execution state carry the live status). Parent: [[layer-boundaries-and-json-seam]]; the M0–M4 slice pattern: [[json-seam-build-plans]].

**State.** The JSON seam arc runs on branch `feat/json-seam-protocol` (never commit/push/checkout `dev`/`main`). M5 (contract) + M6 (agent as protocol client) landed 2026-08-02; **M7 (bookends through the seam) COMPLETE 2026-08-05** — M7.3 character creation (`ed91227`) closed its three review items and settled wizard state ownership in `docs/decisions/wizard-session-ownership.md`; `itemSetName` is now REQUIRED for protocol seeding. **M8 (read-only screens through the seam) COMPLETE 2026-08-06** — M8.0 screens oracle (`ceda557`, 18 golden transcripts, review clean) then **M8.1 the crossing slice (`30847b7` + review-fix `83c5ef9`, review clean)** — the six `screen.*` events (`screen.look`/`screen.map { focus? }`/`screen.stats`/`screen.backpack`/`screen.journal`/`screen.help`) land with `NoticeViewState` + `addCharacterFacts`, controller `open*` methods, the composition lifted into `src/controller/*Screen.ts`, `resolveScene` as the controller's 7th constructor dep (the harness keeps its fixed stub), no-stamp spies, contract suite in the same commit; the "yet"→"first" unification churned EXACTLY the five charless-nav snapshots (transcripts 4/8/10/13/16) — the M8.1 gate, verified mechanically. The M8.0 mock-log residual landed (`getExits`/`getDiscoveredGraph` call logs). One recorded drift pinned: a throwing engine read on `/stats` now surfaces as `ok:false 'internal'` content with no `notifyAdmin` (the seam's never-throws boundary; the dispatch-oracle test pins it + a new `/action` adapter-throw test keeps the dispatcher catch covered). 94 files / 1971 tests green.

**M8.5 (smoke-run tooling) COMPLETE 2026-08-06** — all 9 checklist stages landed on `feat/json-seam-protocol`: stages 1-7 — protocol log (DC-S1, `beae128`+`d14db64`), session bootstrap (DC-S7, `c022d1f`+`8ae01c0`), observer boundary (DC-S4, `46e73b8`+`06434e6`), parity beats + realism arm (DC-S3, `4a8b3c9`+`162b108`), StubBackend extraction (`5606684`), stub-backed run (DC-S2, `c3f2362`+`cecece8`), replay runner + choice-fidelity (DC-S2+DC-S5, `28d5340`+`59d6fb3`) — 98 files / 2013 tests green, `npm run agent:replay` live-verified (stub run → 24 passed, 0 mismatches, exit 0). The verify-first probe settled the DC-S2 scope: real-backend byte-replay HOLDS for the deterministic class (characterId reproducible on a fresh engine; JSON-form deep-equality — the undefined-optional-field equivalence the contract suite's round-trip convention blesses), so the corpus can include deterministic real-backend transcripts (same-weekday-class caveat now covers the greeting AND the nightly tick — SF3). **Stage 8 (DC-S5 contract suite) DONE 2026-08-06** — the "choice fidelity (agent stream)" describe with the fixture generated IN-PROCESS at test time (`18c46cb` + review-fix `ccf1947`, review sound-as-is; 98 files / 2016 tests green) — fixture in-process per the stage-7 coordinator pin, legality routed through replay.ts's machinery (no reimplementation, no fence widening), real-arm replay proving stream interchangeability with the ONE pinned structural divergence (the canned script idealizes rest; the real engine rejects resting with rolls unspent). **Stage 9 (gate + docs) DONE 2026-08-06** — `tests/agent/protocol-transcript.test.ts` makes the protocol-transcript smoke assertion a permanent test (in-process stub session → protocol log → replay → byte-equal; review-fix `d4bd894` added the non-vacuous entries-length assert + env hermeticity), the M8.5 corpus settles at `tests/fixtures/protocol-corpus/` (`stub-1d.protocol.json`, generated byte-deterministic via `AGENT_PROTOCOL_OUT`, pinned two ways — byte-green replay AND deep-equal to a fresh run; regen command + the SF3 same-weekday-class caveat in the corpus README), changelog `### Internal` one-liner landed, spec-doc execution state + TODO reconciled. 99 files / 2019 tests green. **Next: M9 — the Discord adapter rebuilt onto the protocol** (dispatchInteraction.ts + the command files become translate + paint only; gate: byte-identical — M1 oracle + M2 snapshots + M7.0 bookend coverage + M8.0 screens oracle green with zero snapshot churn, plus the M8.5 replay gate: replay of the M8.5 corpus byte-green). M9 inherits the M8 byte net (screens oracle + contract suite incl. the stage-8 describe) + the M8.5 replay/transcript/corpus tools as its drift net. Watch items carried: the D2 stale `/hi` resume edge stays unpinned (M9 territory), the charless `/help` slash arm now does one `getCharacter` read via `addCharacterFacts` (recorded note — M9's gate should know), the map focus flow-order pin stays indirect (adequate), deterministic real-backend corpus entries deferred to M9 (SF3 same-weekday-class).

**Standing cautions (unchanged, still binding).**

- **Do not use the agent-player to validate balance.** It cannot measure RA-2 at all: the brain overwhelmingly picks the day-job menu over free actions, and `stripWorkInspiration` strips inspiration from work actions by design, so both v12 and v13 returned a **structural** 0% grant rate. RA-2's ~10% target and 3.2-3.7 band stay **unverified** pending human play or a harness switch that forces free actions (the `AGENT_FORCE_FREE_ACTIONS` follow-up is the next arc's first task, not this one). The harness remains a good QA/crash instrument.
- **Live runs need `set -a; . ./.env; set +a` first** (no dotenv). The live `npm run agent:play` smoke run is CLOSED for the M7 closeout (2026-08-05: AGENT_DAYS=1, exit 0, 0 findings); future live runs are opt-in per the `agent-smoke` skill and cost real tokens — keep `AGENT_DAYS` small. The deterministic gate remains the correctness proof.
- **Discipline:** one orchestrated-delegation loop per slice: spec → executor → verify → commit → fresh-context reviewer → triage → fixer → verify → commit → coordinator checkpoint → `/clear`. Atomic commit per slice; changelog current per slice. A green suite is not evidence that a prompt rule is reachable. Scope fences hold: no game-rule/balance/prompt changes (the unsafe-rest penalty moves, it does not change value or conditions), no `sim/` changes, `PROTOCOL_VERSION` stays 1, no `facts` key without a consuming adapter in the same slice, `dispatchInteraction.ts` untouched until M9.

## scratchpad (humans start here)

### Prod-data review — two-week window (2026-07-19 → 08-02, snapshot `warden-20260802-212213`)

Fresh pull succeeded, day 27, 123 actions / 1016 LLM calls / 5 chars — so the RESUME HERE note that prod host `192.168.0.242` was unreachable no longer holds. Two-week window: 37 actions across 8 active days, 3 players (BendiusOver, WernerVanDerMervwe, Sir Gary); **Schlong and Ser Redquad churned after week one** (nothing since 07-13/07-14). BendiusOver is the only tester on new content (45 of 123 lifetime actions) and he ended the week at 1/10 HP after his worst session. The **only feedback filed in the entire window is "This sucked"** (F#14, 08-02 14:41, 12s after bailing a fight) — sentiment is otherwise silent, the player only files when something breaks.

**The 08-02 wolf fight is the pain centre** (B#17-19): 13 combat rounds, 14 LLM calls, ~95k tokens, ~20 min wall-clock (14:20 → 14:40), avg ~19s per round, ending in a bail worth just −1 stamina. Player-reported state inconsistencies: enemy HP bar bounces down and back to full mid-action, difficulty flips hard→medium, card shows a minion instead of the wolf, and a "final stand" fires mid-win with a −7 margin and both sides losing 1 HP. This was also the **first human exposure to the v13 hard 16-18 ladder** and it ended in frustration, so the RESUME HERE "combined feel may read stingy" caution is now a live concern, not theory.

**Latency degraded sharply in the last 3 days**: 07-31 avg 16.1s (5 calls >30s, one 60s abort — the reality-fracture decide), 08-02 avg 18.7s (5 calls >30s, max 43s), vs 5.7-7.9s avg for 07-19 → 07-30. The 07-31 spike ran v12 prompts, so it predates v13 → provider-side contention on deepseek-v4-flash is the prime suspect, not the prompt set. Note 0.3.3's fail-open fix (commit `15277e3`) has not yet absorbed a real abort — the 07-31 one died under 0.3.2.

**Health checks that came back green**: parse_ok 99.8% (2 failures ever, both 60s aborts), zero fallbacks, zero validation warnings, zero HTTP errors, no `done` auto-resolve outcomes at all. Roll-economy question answered: B#16 "was my roll really refunded" — yes, the 07-28 10:30 timed-out fish (DC 14, no roll spent) was retried at 10:36 with a fresh roll and succeeded.

**Follow-ups:**

- [ ] **Combat length**: 13 rounds reads as "repeat spamming press the attack" (F#14/B#19). A round cap or an explicit mid-fight "press the advantage / break off" affordance; the bail path exists but costs nothing and reads as defeat.
- [ ] **Combat state desync**: minion↔wolf mixup, HP-bar bounce, hard→medium drift (B#17-19) point at the persisted in-combat edge disagreeing with what the card renders. Trace the 08-02 calls end-to-end. Related to the open C4 in_combat-edge-duplication item.
- [ ] **Latency investigation**: decide-call latency roughly tripled 07-30 → 07-31/08-02 (avg ~19s on 08-02; 10 calls >30s across two sessions). Suspect provider contention; also check reasoning-length growth per beat. Cross-refs the MVP "LLM latency" item and the classify-critic TBD item.
- [ ] **RA-1/RA-2 first-exposure watch**: the re-anchored ladder's only human test ended in a bail + "This sucked", and the player is at 1/10 HP; combined stinginess remains unmeasured. The next BendiusOver session is the datapoint.
- [ ] **Retention**: 2/5 characters churned after week one; the active tester's worst session was the most recent. Worth revisiting the stage-2 solo-first plan (nat 1/20 beats) as a hook before wider invites.

### POC+ re-sequencing — prod-data review (2026-07-23)

Full-period prod snapshot (`warden-20260723-201953`, 07-07 → 07-23, day 17, `0.3.0`–`0.3.2`; 98 actions / 796 LLM calls / 4 chars / 1 external tester) drove a re-order of the remaining POC+ arc, recorded in [[poc-plus-roadmap]] (§ Re-sequencing). No controlled invite — the rest of POC+ playtesting is agent-driven; human testing is scheduled later. **Release A lands before any more shared-world code.**

**Release A — worth-returning-to (polish / coherence / cost)**

- [x] **Stakes / difficulty pass** *(RA-1)*: item-bonus ceiling, the DC ladder and the reward/failure menus all landed (stage 4), and P1 restated the ladder on the final per-option DC, closing the last open v13 prompt defect. The failure-cost rule measured 21/21 compliant, up from 0/12 on v12. **Residual, re-homed here (not dropped):** the daunting band is now fixed in prose and the arithmetic checks out, but no re-probe was run, so it stays unverified behaviourally, needing isolated DECIDE probes (the kind stage 4 used), not an agent-player run. No lethality (death track stays deferred). Overlaps the MVP "make wealth (and stamina, health) spendable/meaningful" item below.
- [x] **Inspiration dial** *(RA-2)*: all four prompt/engine halves landed (F#12 strip, named-reward line, the v13 frequency dial, the rest-channel fix). **Residual, re-homed here (not dropped):** the ~10% target and 3.2-3.7 band remain unverified, since the agent-player structurally cannot check them (day-job work strips inspiration by design, and the brain overwhelmingly picks day-job work over free actions). Needs human play, or a harness switch that forces free actions, before anyone concludes it worked.
- [x] **NPC mint-on-first-sight** — both halves landed: RA-3's combat half (`anchor: 'npc'` minted on a surviving foe) and stage 4 step 4's `add_npc` `health` vocab plus the mint-on-first-sight instruction for narrated newcomers.

**Release A closeout — three decisions left open** (full write-ups in the plan's § Follow-up logged)

- [?] **`opts.compact` has had no production caller since RA-6** — still plumbed through `buildOutcomeView`/`viewState.ts`/`commands/action.ts` with a unit test. Delete it, or keep it as a deliberate capability.
- [ ] **Give the agent-player a way to exercise the quest loop** — an `AGENT_FORCE_FREE_ACTIONS`-style switch, or a brain prompt that rations day-job picks. Without it the harness can't answer any balance question about free actions (§ RESUME HERE, standing cautions).
- [x] **RESOLVE is told to scale the reward by the DC attempted, and is never sent a DC** *(found by P1's review; fixed as P3 rather than deferred, see [[resolve-difficulty-signal]])* — a DC-checked attempt now carries `final dc`, a fight carries the `foe danger` tier the combat card already renders, and an auto-resolve carries neither. **Two residuals logged in that doc, both balance decisions rather than wiring:** `dangerTier`'s thresholds predate v13's ladder, so an ordinary 16-17 fight reads `hard` (re-tuning them also moves the combat card, so it needs measurement); and the card/narration match is per round, not per fight, because each CONTINUE round re-authors `baseDc`.

**Stage 2 re-scope + later stages**

- [ ] **Stage 2 solo-first** — nat 20 grants extra loot/rolls (F#9), nat 1 a story beat; public broadcast is the bonus layer. Lands at N=1.
- [ ] **Stages 3–4 (buffs, shared boss)** — build + agent-QA only for now; extend the agent-player harness to co-located multi-agent runs; fun-payoff deferred to later user testing.

### M4 agent-player live smoke-run findings (2026-07-21)

Three live DeepSeek smoke runs (1d, 1d, 2d) all completed clean (exit 0, 0 formal findings, coherent gameplay, critic reports). Multi-day path confirmed (day advances, rolls refill, overnight regen + income, rest-to-Oak). These observations are NOT harness bugs (all self-recovered, no state corruption) — logged for maintainer/backlog:

- [ ] **[engine/prompt] LLM authored an out-of-graph `scene_location`** — twice in one run the model named a location outside the geography graph ("The Vale", then "Town Square · The Vale") with no relocate mutation; the travel-gate + graph validator correctly no-op'd both (no player-visible corruption). The `place · region` format matches the display convention (`src/discord/map-render.ts:117`, `src/llm/prompt-builder.ts:243`) — the model is likely echoing a compound display string back into the raw `scene_location` field. Sanity-check whether the prompt/context renders location as `place · region` somewhere the model could mistake it for the field value.
- [ ] **[UX] bail-refund grace has no in-game signal** — the once-per-day free step-back (`last_bail_refund_day`, `src/engine/WorldEngineImpl.ts`) reads as inconsistent to a player (first bail refunds a roll, second same-day doesn't) with nothing explaining it; a small UI note ("first step-back today is free") would remove the ambiguity the critic flagged. Not a bug.
- [ ] **[M4 enhancement] promote engine anomaly logs to transcript findings** — engine-emitted anomaly recoveries (`category-telemetry`, `travel-gate` injections/drops) print to stderr but the agent-player harness doesn't capture them as `finding`s, so they're invisible in the run scoreboard. Surfacing anomalies as findings is the harness's whole job; a future QA-capture slice could hook these engine emissions into transcript warnings. (The `play.ts` stdout-contamination defect the same runs caught is already FIXED — transcript now writes to a file, `AGENT_OUT`.)

### M8.5 live agent-player smoke-run findings (2026-08-06)

First live runs on the M8.5 harness, realism arm on (the brain authored the character through the wizard — fresh spawn through the seam), 2× 1-day + 1× 2-day on `feat/json-seam-protocol`. **The seam itself held:** all three wizard walks recorded through the protocol (`join.open` → `wizard.answer` → `wizard.choose` ×6 → `character.create`), parity beats + protocol logs produced (smoke-a: 42 entries, smoke-b: 32), zero invariant breaches, zero roll underflow, clean `no-rolls` day ends, and every DeepSeek decide-timeout absorbed by the designed fail-open (divine intervention + refund on beat-1; TIMED OUT + roll refunded on later beats; critic keep-original). Findings:

- [ ] **[harness] No watchdog for a wedged in-flight LLM request** *(smoke-c died mid-day-1)* — after a successful move the process sat alive-but-silent 4–6 min with no abort logged; the 30s/60s abort either never fired or didn't interrupt the fetch (a wedged socket can outlive an AbortController). One wedged request stalls a live run indefinitely — needs a top-level guard (heartbeat + hard kill, or a per-call timeout that actually aborts the socket).
- [ ] **[harness] Single-end `writeFileSync` in `finally` defeats the repro guarantee on signal death** *(smoke-c)* — a kill skips `finally`: zero transcript, zero protocol log, zero scoreboard (the run's death itself was the only artifact). A live-run harness that can outlive its controlling shell should append the transcript incrementally so a killed run still leaves evidence.
- [ ] **[engine/prompt] Failure branch keeps the success reward — wealth +3 on a failed `search`** *(smoke-b; also smoke-a: +3 on every resolved action incl. failures)* — a failed search applied `-item:Fresh Hare, stamina−1, wealth+3`: the failure template looks like the success template with only the item sign flipped, leaving `modify_wealth` on a failure. The `CATEGORY_MUTATION_MAP` telemetry flagged `modify_wealth`/`remove_item` as unexpected on `search`, and smoke-b's critic independently called the "− Fresh Hare alongside +💰 3" screen contradictory. Either the resolve-mutate prompt template for `search` leaks the reward into failure, or the model mirrors the success recipe with the item flipped — route via the `prompt-versioning` skill. *(The telemetry-flag↔findings disconnect is the existing [M4 enhancement] item above — telemetry flags never surface as transcript findings.)*
- [ ] **[infra] Decide-stage DeepSeek timeouts spike under concurrent live runs** *(a: 3, b: 2, c: 2 decide timeouts in a ~15-min window)* — three parallel live runs on one key plausibly contributed to provider flakiness (new datapoint on the known 07-31/08-02 latency degradation). The fail-open paths all held. Future fleets: ≤2 concurrent, or stagger.
- [ ] **[game-design] Favoured-option risk mismatch** *(smoke-a critic)* — a favoured option rolling 8 vs DC 8 read as FAILURE (strict-beat ties fail) with harsh fallout (−1 HP, −2 stamina, −kit) while a cautious option succeeded comfortably — the arrow/favoured hints don't match actual risk. Cross-refs the v13 ladder "combined feel may read stingy" caution.
- [ ] **[QA] The multi-day live path remains unverified** — smoke-c died mid-day-1 (no day boundary, no roll refill/regen/income observation). Needs a re-run (quieter window, ≤2 concurrent) once the watchdog + incremental-write items land.
- [>] **[harness] The realism arm didn't fix move variety** — the a/b brains picked `menu-pick 0` / `choice 0` (or the favoured option) almost exclusively; the brain still funnels into the day-job menu. Re-confirms the standing caution (no balance validation via the agent-player; `AGENT_FORCE_FREE_ACTIONS` remains the next arc's first task).

### 0.3.2 residuals (prompt-versioning + [[prompt-v13-roadmap]])

*v13 has shipped, so the two items still open here carry to whatever prompt set comes next — route via the `prompt-versioning` skill and remember a published set is copied, never edited in place.*

- [ ] **C6 symptom-A — mis-classification accuracy** *(deferred 0.3.2)*: actions the player intends as combat are sometimes classified as `skill`/`rest`, routing to the wrong spine. The auto-resolve guard (C6) prevents a combat-classified action from resolving without a fight, but the upstream classify decision is a prompt-template concern → route via `prompt-versioning` skill, [[prompt-v13-roadmap]].
- [ ] **`ItemData` has no `kind`/`slot`/`consumable` column** *(RA-1 Stage 1 follow-up)*: the engine can't distinguish a consumable from a weapon and can't hold consumables to +1, so the v13 "consumable reads +1" guidance is prompt-only and unenforced until such a column exists.

**C4 follow-ups left out of that fix:**

- [ ] **C4 follow-up — abandoned (not bailed) mid-round combat shows no opening frame on resume**: a genuinely unfinished multi-round fight leaves last_action_state set; `/action` then hits the resume branch (`action.ts:162`), which calls `buildDecisionMessage` without `actionType`, so no opening frame renders at all (and `decisionIdx > 0` would gate it out anyway). Latent, not the reported symptom. Needs `resumeAction`/`ActionResumeResult` to carry actionType + remembered foe and the render gate to allow a combat opener on resume.
- [ ] **C4 follow-up — in_combat edge duplication on anchor change**: `set_relation`'s UNIQUE key includes the anchor (`to_type,to_ref`), so a re-engage that resolves to a *different* anchor than the bailed edge creates a second `in_combat` edge; `readCombatState` then picks whichever the DB returns first. Harmless for same-anchor re-engage (the common path). Needs an edge-lifecycle sweep, not part of the C4 symptom fix.

### TBD — POC polish (small UI wins, no spark warranted)

- [/] combat or social actions HAVE to mint NPC. no thing can be referenced without existing or spawning to persist? *(largely addressed: RA-3 mints a surviving named foe, and v13's `add_npc` tells the model to mint a narrated newcomer on first sight. What's left is making it a hard guarantee rather than prompt guidance.)*
- [ ] remove critic from classify. conditionally. latency seems high. mine prod for investigation *(note: RA-4 already gated the narrate critic — `CRITIC_GATE_MODE`, default `narrate-gated`; this item is the classify stage specifically.)*
- [ ] many frame has two spaces for padding left. refactor to 1
- [ ] map seems formatted weird:

```
The Vale (home)
🌳🛡️ The Warden's Oak
├─ 🌿⚠️🏃 The Forest Edge  ◀ you are here
│  └─ 🌲⚠️🧗 The Dark Pines
├─ 🛤️⚠️🚶 The East Road
│  └─ 🏚️⚠️🧗 The Broken Keep
├─ 🌊⚠️🏃 The River Crossing
├─ ⛪🛡️🚶 The Shrine of the First Flame
└─ 🏛️🛡️🚶 Town Square
   ├─ 🔥🛡️🚶 The Town Forge
   ├─ 📚🛡️🚶 The Warden's Library
   └─ 🍺🛡️🚶 The Weary Lantern Inn
Unexplored paths
🛤️ The East Road
└─ 🏃 ↗️ the road runs on to the eastern town
🌲 The Dark Pines
└─ 🧗 ⬇️ the trees never thin — the deep woods swallow the trail
🌊 The River Crossing
└─ 🧗 ⬅️ downriver the banks close in, and caves breathe cold air
🌿 The Forest Edge
└─ 🏃 ➡️ The Stag's Den
```

the bottom unexplored path for the stags den should actually render in the top, but greyed out or something to show its unexplored.
one would look at the "you are here" first , then aroud you, and having the forest edge not show there is bad UX

- [ ] improve art blocks on messages
  - drop the old ugly scene ascii. this will be only used for look.
  - like the art on the classified outcome page should be redisplayed on the thinking page.
  - and maintained on the decision outcomes.
  - art should be considered the main viewport, and the discord messaging a sub menu or interaciton layer with inline art blocks.
  - maybe drop the location ascii image from actions
- [ ] the thinking block might as well show the full decision history exactly like action outcome
  - it should also show the main frame block
  - same for the epemeral version of actions responses.
  - it should have a hints block that the player can reed while waiting. periodically scrape the docs and features for interactions lesser known of (like regex resolving, ...)
- [ ] footer emoji for location changes should show location emoji
- [ ] travel prompt should inject the current location, edge, and final location state. and routes to get there.
- [ ] movement on low difficulty terrain can be deterministic for up to a total of 3 effort, 3 times 1 difficulty edges. Or a 1 and 2 difficulty edge. When traversing a 3 (or greater) difficulty edge in one action, the travel prompt has to trigger.
  - actions that involve movement but isn't it directly, like prompting to search the library from the wardens oak, should ensure that the travel beat is first evaluated (could auto travel, or demand travel as a seperate action).
- [ ] dynamically request or load context. Instead of sending the LLM all possible context, give it an NCP-like interaction layer.
  - scripts or command that perform lookups from the world state that is provided to the decision and mutations DMAs
- [ ] populate more locaiton edges in the seeds
- [ ] improve daily work options
- [ ] hitting 0 stamina should block more actions that day.
  - also, 0 hp should do this but also roll the dice, mkaing a death save...
- [ ] last stand buttons and captions need to look cooler. add emojis or a combat scene frame and shit.
- [ ] clearing bad people in an unsafe space should grant a short rest if it is your last action of the day. maybe helps your reach the oak during the night? (slightly risky?)
  - there should be a short version of rest this is usable once per day before or between actions. Drop blocker
- [ ] On consequtive action decision screens, the art block should evolve/update accordingly, sometime zoom or change the scene. etc
  - the inline art block no longers has to display HP if the main frame does

### ANSI — outstanding work (consolidated 2026-07-11)

**Opening-frame runtime gaps** (from the ANSI-F review — the frame ships but misses these paths):

- [ ] Opening frame on auto-resolved actions: travel/rest often resolve at start with no decision beat, so they show no opening frame today (3 auto-finish call sites + the public-broadcast embed question). Extend the frame to the outcome path.
- [ ] Resume-mid-action shows no opening frame at decisionIdx 0 (`resumeAction` doesn't carry `actionType`); rare, degrades gracefully.
- [ ] Combat opening frame renders "Unknown foe" pre-first-step; `PipelineDecideResult.combatEnemy` exists but isn't exposed publicly — enrich when worth it.
- [ ] Cartographer enrichment has no active retry sweep (N2 residual): the mint→fire wiring is fixed (`mintedSince` diff fires the async cartographer for freshly-crossed frontiers), but a `enrich()` that throws is only `console.warn`-logged and leaves the row `enrichment_pending = 1` forever — nothing re-attempts it. Add a bounded retry/reconciler (e.g. sweep pending rows on tick, capped by a retry counter) so a transient LLM failure self-heals instead of leaving a permanent placeholder.

**Art depth & migration** (deferred / mvp+):

- [ ] Fragment catalogue (enemy sprites, NPC busts, campfire, PC poses) — gates real art in the opening/combat frames; until it lands, sprite/scene slots render as deliberate placeholder scenes. See [[ansi-art-classification-framework]] §9, [[mvp+ansi-art]]. This is now the single next bottleneck for POC+ art coverage.
- [ ] migrate ascii to ansi in semantics, source files, and references — the 23 `assets/scenes/*.ascii` still coexist with the new `src/render/` ANSI system.
- [ ] render ansi as images? so mobile works? (colour degrades to monochrome on mobile today.) Longer-term, MVP(+) below wants the ANSI engine rewritten into compiled pixel-art images.
- [ ] Stage-2 BROADCAST_CARD frame — reuses the renderer; built when stage 2 (nat 1/20 broadcast) lands.

### action pipeline framework refactor closeout

Remaining from the v13 roadmap (`docs/engine/prompt-v13-roadmap.md`), in its suggested order:

1. D3/D4 — conversation & puzzle shapes + the free-text security stack: the biggest unspecced chunk; can be specced immediately since the relationship edges are already live. Needs a stage-N-style build plan before implementation.
2. (after a few live weeks of telemetry) Prose-critic trigger decision from the CombatBeatLog data, recorded as a decisions/ doc.
3. Roadmap stage 4 — Thread B world scaling: also wants live curves before tuning; the scale seam sits at 1.

### Player requests — prod data review (2026-07-08)

Fresh reports from a single QA session (snapshot `warden-20260708-201456`, character BendiusOver — mostly a combat playtest). `F#`/`B#` cite the `feedback`/`bug_reports` row. Cross-refs to existing items noted inline; where an item just re-surfaces a known one, treat this as a fresh datapoint rather than a new task.

**Feedback / feature asks**

- [ ] **Richer `/hi` opening prose** — pressing Hi should generate a prose opener that scales with time since last interaction (referencing days or a few actions) and reminds the player of their work, quests, and loose ends (F#2). Extends the existing "morning/evening custom prose" and "add /hi to the new-hero message" TBD items.
- [ ] **Buttons going missing is annoying — do the menu rework soon** (F#5). Fresh datapoint bumping the "menu framework coupled to views" MVP item / [[discord-interaction-layer]].

### Player requests — prod data review (2026-07-03)

Open *feature* asks mined from the `feedback`/`bug_reports` tables (snapshot `warden-20260703-133521`). Bug-shaped reports already fixed in `[Unreleased]`/0.2.5–0.2.6 are omitted; these are the requests still open. `F#`/`B#` cite the feedback/bug row. The four POC-sized Discord/comms wins are lumped into the **[[polish-v0.2.8]]** spark; the rest route to MVP/sparks.

- [ ] **Player-founded structures become real locations** — a player who *starts building* a temple expects it to exist as its own explorable/buildable place, not resolve to an existing or adjacent location (F#4, B#8 — Ulrich's temple). Relates to lazy world growth + world-state tracking [[mvp-data-model]].
- [ ] **Cross-player buff actions** — praying/blessing "for everyone" should actually apply a buff mutation to the other players present, not no-op (B#11). Needs a multiplayer-aware mutation.
- [ ] **Items should be usable, not stat-bonus clutter** — players accumulate notes/keys/etc. that only grant a passive stat bonus and never get *used*; make items actually do something (F#11). Tracked in [[improved-item-features]] but not previously on this list.
- [ ] **Communal / offering currency separate from personal gold** — a player wanted to spend offering-basket funds (not their own coin) on temple supplies; distinguish a shared/temple purse from personal wealth (F#9). Nuance under the MVP "make wealth spendable/meaningful" item below.

## MVP — deferred

- [ ] any periodic channel message should be re evaluated.
- [ ] dnd statblock scraper
- [ ] menu framework coupled to views — standardise the views/command/message terminology and a tab/subtab layout per message. See [[discord-interaction-layer]] (the interaction-plumbing layer; subtabs are explicitly MVP there).
- [ ] make wealth (and stamina, health) spendable/meaningful, and define death / 0 HP. The death track is deferred from the POC by design ([[the-poc]]); see [[mvp-progression]] (lifecycle/death), [[mvp-combat]] (HP stakes), [[mvp+npc-economy]] (wealth sink).
- [ ] cap rolls per action type + add a short-rest option; reward slow build-up / daily-work play on subsequent actions instead of jumping straight in. Check for hard-coded roll caps. Extends [[roll-economy-timeouts-and-world-growth]].
- [ ] character progression depth — levels, upskilling, traits; the char creator shows which stats matter per race/class and how each modifies them. See [[mvp-progression]], [[mvp-character-drivers]].
- [ ] richer community feedback in chat — tag people (not too spammy), let players show off to each other. See [[mvp-social-model]], [[mvp-discord-ux]].
- [ ] use both models differently, flash for generating quick responses and daily work, pro for decision trees.
- [ ] **LLM latency** *(deferred from [[polish-v0.2.8]], 2026-07-04)* — the 2026-07-04 snapshot shows mean ~12.8s, 94 calls >20s, 26 >30s (max 47.5s); this is what surfaces to players as `timed_out`/`bailed` outcomes. Rein in reasoning length and tighten the timeout+fallback. Overlaps the model-split above and the thinking-on/off experiments in [[mvp-llm-prompt-architecture]].
- [ ] **Auto-resolve roll refund** *(deferred from [[polish-v0.2.8]], 2026-07-04)* — bug reports say a `done` auto-resolve can consume a roll while doing nothing / not refund it (B#1, B#10). The no-op/timeout/bail refund graces already exist and this list concluded there's no deterministic double-decrement in `startAction`, so the job is to verify the `done` path specifically hands the roll back on a true no-op. Part of the broader auto-resolve wound owned by the prompt refactor.
- [>] saturday special event, spawn an "evil npc" somewhere with a hint. Incentivise hunting it/them and add npc death mutation → minimal slice (one scripted weekly boss, shared HP) now [[poc-plus-roadmap]] item 5; npc death mutation and the wider event pool stay MVP.
- [ ] choose age
- [ ] Improved journal/story
  - track or show quests or hints?
  - add clue system? also grants +1 roll
- [>] travelling to existing or already explored areas should be deterministic based on the distance and/or difficulty. → now designed in [[per-player-map-exploration]] (engine-owned routing + `stamina = Σ edge difficulty`; `distance` reserved for the time mechanic).
- [ ] **schema: normalise location references to FK ids** — locations are keyed by `name` (TEXT) everywhere (`player_characters.location`, `npcs.location`, `location_edges`, `actions.location_name`). `actions.location_name` is a deliberate point-in-time *snapshot* (keep it), but a future polish pass should decide whether the live-reference tables move to `location_id` FKs consistently — a holistic refactor, not a lone divergence. See [[per-player-map-exploration]] §6.
- [ ] use reactions as a way of buffering input before a button is pressed (expend items or use certain abilities to amplify actions, also works for trades)
  `this is cool!!!`
  (but does it work with ephemeral..?)
- [ ] stealth or following mechanics?
- [>] `[[mvp-llm-prompt-architecture]]` — prompt refactor:
  - optimise prompt to llm as markdown (more friendly) not json. Response can remain json
  - options should still be produced by the llm, but there should be some rolls before to influence it
    example: player prompts they want to hunt. llm responds with choices, player succeeds, bot then rolls for rarity of an item, llm generates item.
    example: player trains at camp, llm provides choices, player fails, bot rolls for the severity (loses a lot of stamina), llm gives outcome message.
    THIS IDEA NEEDS A LOT OF REFINEMENT or just better system prompts.
  - outcomes should be rolled before the response flavour is generated.
    roll as DM and add certain promp elements. determine outcome sentiment before prompting.
  - utilise multiple agent in short bursts for actions or chain agents instead of one big chat?
  - try disabling thinking again? Or use A B testing with thinking on and off
  - optimise prompts with simulations to see when LLM digresses
  - use testing data as a couple of LLM mocks (for dev'ing or unit testing)
- [>] `[[mvp-combat]]` — there is no combat, this should be a core mechanic..!
- [>] `[[mvp-data-model]]` — graph db for backend coherency (relationships, items, distances, groups)
  - better world state tracking, which areas are hostile, how hostile, what type of faction or encounters to expect
- [>] `[[mvp+npc-economy]]` — introduce NPCs more often in interactions and save them (also reuse them more often)
- [>] `[[mvp+world-state-projection]]` — rethink sleep mechanic, yes we want people to sleep at the wardens oak, but they shouldnt be able to just tp out of an unsafe or far away location.
  - related to world state tracking too: finishing your day in an unsafe location should have conesquences
    (you dont sleep well or you get put in jail and must escape)
- [>] `[[mvp-ascii-render-pipeline]]` — scrape prettier ascii art or images for converting with ascii image converter

# MVP(+)?

- [ ] the ansi art engine should be re written in custom font character that are compiled into an actual image and sent as pixelated art.
