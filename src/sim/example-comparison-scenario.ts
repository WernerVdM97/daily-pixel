import type { CharacterSeed, ComparisonScenario, DecisionScript, PipelineScript } from './types.js';

/**
 * A single hand-authored combat turn, scripted once for the legacy machine and once for the
 * pipeline machine, proving `runComparison` (driver.ts) drives one scenario through both. Per
 * the Stage 1 Thread D Task 4 spec, this is deliberately the ONE example the effort calls for —
 * porting every `src/sim/scenarios/*.json` fixture to a pipeline-equivalent script is explicitly
 * out of scope (decide's shape differs and resolve is split in two between the machines, so a
 * legacy script and a pipeline script are never auto-derivable from one another).
 *
 * "attack the goblin" is a clean heuristic-classify hit (classifier.ts's combat table: the bare
 * keyword "attack" plus a determiner-noun phrase for target_present) — no `classify` callback is
 * needed on the pipeline script.
 */
const character: CharacterSeed = {
  class: 'Warrior',
  stats: { physical: 5, wisdom: 0, intelligence: 0, charisma: 0 },
  health: 10,
  maxHealth: 10,
  stamina: 10,
  maxStamina: 10,
  wealth: 0,
  location: "The Warden's Oak",
  alignment: 'lawful good',
  dayJob: 'Blacksmith',
};

// Legacy machine calls decide() up to twice per beat (open decision, then narrate-as-resolve on
// `done: true`) — keyed off `previousDecisions.length` so it replays correctly regardless of
// call count, same convention as tests/sim/driver.test.ts's huntScript. The opening beat offers
// TWO real (non-bail) options, not one — legacy's universal degenerate-decision-shape guard
// (machine.ts) retries (then resolves as a refundable no-op) an opening beat with only one real
// option, since a bail doesn't count as a real choice.
const legacyScript: DecisionScript = (ctx) => {
  if (!ctx.previousDecisions || ctx.previousDecisions.length === 0) {
    return {
      prompt: 'A goblin snarls, blade drawn.',
      distilledType: 'combat',
      stat: 'physical',
      baseDc: 10,
      required: false,
      done: false,
      decision: [
        { label: 'Press the attack', dcModifier: 0 },
        { label: 'Feint and strike', dcModifier: 1 },
        { label: 'Step back', dcModifier: null },
      ],
    };
  }
  return {
    prompt: '',
    distilledType: 'combat',
    stat: 'physical',
    baseDc: 10,
    required: false,
    done: true,
    decision: [{ label: 'Finish it', dcModifier: 0 }],
    mutations: [{ type: 'modify_wealth', amount: 5 }],
    outcomeText: 'Your blade finds its mark; the goblin falls.',
  };
};

// Pipeline machine's DECIDE fires twice too (the beat cap in PipelineActionStateMachine.step
// mirrors the legacy shape) but never authors mutations/outcome_text — those are
// RESOLVE-MUTATE/RESOLVE-NARRATE's job below (the D5b split this whole pipeline exists for).
// No degenerate-shape guard exists in the pipeline machine, but this mirrors the legacy script's
// two-real-options shape anyway for a fair side-by-side comparison.
const pipelineScript: PipelineScript = {
  decide: () => ({
    distilledType: 'combat',
    stat: 'physical',
    baseDc: 10,
    required: false,
    decision: [
      { label: 'Press the attack', dcModifier: 0 },
      { label: 'Feint and strike', dcModifier: 1 },
      { label: 'Step back', dcModifier: null },
    ],
  }),
  resolveMutate: () => ({
    mutations: [{ type: 'modify_wealth', amount: 5 }],
  }),
  resolveNarrate: () => ({
    outcomeText: 'Your blade finds its mark; the goblin falls.',
  }),
};

export const exampleComparisonScenario: ComparisonScenario = {
  name: 'goblin-skirmish',
  character,
  // Fixed 20 guarantees success against this scenario's low DC regardless of which machine
  // computed the roll bonus, so both runs land on the same 'success' outcome deterministically.
  rollSource: { kind: 'fixed', value: 20 },
  legacyScript,
  pipelineScript,
  week: [[{ input: 'attack the goblin', choicePolicy: 'first-real' }]],
};
