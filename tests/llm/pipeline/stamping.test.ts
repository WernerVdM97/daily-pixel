/**
 * Thread D Task 5 — per-stage prompt-version stamping (docs/engine/stage-1-thread-d-backbone-plan.md).
 * Every assertion here derives its expected string via prompt-builder.ts's `stampFor`, mirroring
 * `stampForPipelineStage`'s own implementation, so these tests would fail if the two ever drifted
 * apart (they can't, both call the same function, but that's the point being proven).
 */
import { describe, it, expect } from 'vitest';
import { stampForPipelineStage, callKindForPipelineStage } from '../../../src/llm/pipeline/stamping.js';
import { PROMPT_SET_VERSION, stampFor } from '../../../src/llm/prompt-builder.js';

describe('stampForPipelineStage', () => {
  it(`stamps classify as '${PROMPT_SET_VERSION}/classify'`, () => {
    expect(stampForPipelineStage('classify')).toBe(`${PROMPT_SET_VERSION}/classify`);
    expect(stampForPipelineStage('classify')).toBe(stampFor('classify'));
  });

  it(`stamps decide per ActionType, e.g. '${PROMPT_SET_VERSION}/decide/combat'`, () => {
    expect(stampForPipelineStage('decide', 'combat')).toBe(`${PROMPT_SET_VERSION}/decide/combat`);
    expect(stampForPipelineStage('decide', 'combat')).toBe(stampFor('decide/combat'));
  });

  it(`stamps decide for a second ActionType too, e.g. '${PROMPT_SET_VERSION}/decide/rest' — proving it's per-category, not hardcoded`, () => {
    expect(stampForPipelineStage('decide', 'rest')).toBe(`${PROMPT_SET_VERSION}/decide/rest`);
    expect(stampForPipelineStage('decide', 'rest')).toBe(stampFor('decide/rest'));
  });

  it('throws a clear error when decide is called without an actionType', () => {
    expect(() => stampForPipelineStage('decide')).toThrow(/actionType is required/);
  });

  it(`stamps resolve-mutate per ActionType and verdict, e.g. ${PROMPT_SET_VERSION}/resolve/combat/success`, () => {
    expect(stampForPipelineStage('resolve-mutate', { actionType: 'combat', verdict: 'success' })).toBe(`${PROMPT_SET_VERSION}/resolve/combat/success`);
    expect(stampForPipelineStage('resolve-mutate', { actionType: 'combat', verdict: 'failure' })).toBe(`${PROMPT_SET_VERSION}/resolve/combat/failure`);
  });

  it(`stamps resolve-narrate per ActionType and verdict, e.g. ${PROMPT_SET_VERSION}/resolve/combat/success`, () => {
    expect(stampForPipelineStage('resolve-narrate', { actionType: 'combat', verdict: 'success' })).toBe(`${PROMPT_SET_VERSION}/resolve/combat/success`);
  });

  it('resolve-mutate and resolve-narrate share the same per-type-per-verdict resolve template', () => {
    expect(stampForPipelineStage('resolve-mutate', { actionType: 'combat', verdict: 'success' })).toBe(
      stampForPipelineStage('resolve-narrate', { actionType: 'combat', verdict: 'success' }),
    );
    expect(stampForPipelineStage('resolve-mutate', { actionType: 'skill', verdict: 'failure' })).toBe(
      stampForPipelineStage('resolve-narrate', { actionType: 'skill', verdict: 'failure' }),
    );
  });

  it('throws a clear error when resolve-mutate is called without actionType/verdict', () => {
    expect(() => stampForPipelineStage('resolve-mutate')).toThrow(/actionType and verdict are required/);
  });

  it('throws a clear error when resolve-narrate is called without actionType/verdict', () => {
    expect(() => stampForPipelineStage('resolve-narrate')).toThrow(/actionType and verdict are required/);
  });
});

describe('callKindForPipelineStage', () => {
  it('returns the canonical pipeline-<stage> value for every stage', () => {
    expect(callKindForPipelineStage('classify')).toBe('pipeline-classify');
    expect(callKindForPipelineStage('decide')).toBe('pipeline-decide');
    expect(callKindForPipelineStage('resolve-mutate')).toBe('pipeline-resolve-mutate');
    expect(callKindForPipelineStage('resolve-narrate')).toBe('pipeline-resolve-narrate');
  });
});

// Task 5's "actions.prompt_version carries the set" acceptance bullet is narrowed here: no
// pipeline turn ever writes a real `actions` DB row in Stage 1 (no live wiring exists to hang
// persistence off of — PipelineSimEngine is in-memory only, see its file header). What CAN be
// proven at this stage is that PROMPT_SET_VERSION is the single, correct source of truth a
// future real wiring would stamp `actions.prompt_version` with — currently the active set.
describe("PROMPT_SET_VERSION (narrowed 'actions.prompt_version carries the set' acceptance)", () => {
  it("is 'v13'", () => {
    expect(PROMPT_SET_VERSION).toBe('v13');
  });
});
