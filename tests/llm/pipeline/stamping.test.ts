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
  it("stamps classify as 'v12/classify'", () => {
    expect(stampForPipelineStage('classify')).toBe('v12/classify');
    expect(stampForPipelineStage('classify')).toBe(stampFor('classify'));
  });

  it("stamps decide per ActionType, e.g. 'v12/combat'", () => {
    expect(stampForPipelineStage('decide', 'combat')).toBe('v12/combat');
    expect(stampForPipelineStage('decide', 'combat')).toBe(stampFor('combat'));
  });

  it("stamps decide for a second ActionType too, e.g. 'v12/rest' — proving it's per-category, not hardcoded", () => {
    expect(stampForPipelineStage('decide', 'rest')).toBe('v12/rest');
    expect(stampForPipelineStage('decide', 'rest')).toBe(stampFor('rest'));
  });

  it('throws a clear error when decide is called without an actionType', () => {
    expect(() => stampForPipelineStage('decide')).toThrow(/actionType is required/);
  });

  it("stamps resolve-mutate as 'v12/resolve'", () => {
    expect(stampForPipelineStage('resolve-mutate')).toBe('v12/resolve');
  });

  it("stamps resolve-narrate as 'v12/resolve'", () => {
    expect(stampForPipelineStage('resolve-narrate')).toBe('v12/resolve');
  });

  it('resolve-mutate and resolve-narrate produce the IDENTICAL stamp — one shared `resolve` template slot, not a bug', () => {
    expect(stampForPipelineStage('resolve-mutate')).toBe(stampForPipelineStage('resolve-narrate'));
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

// Task 5's "actions.prompt_version carries the set (v12)" acceptance bullet is narrowed here:
// no pipeline turn ever writes a real `actions` DB row in Stage 1 (no live wiring exists to
// hang persistence off of — PipelineSimEngine is in-memory only, see its file header). What CAN
// be proven at this stage is that PROMPT_SET_VERSION is the single, correct source of truth a
// future real wiring would stamp `actions.prompt_version` with, and that it's 'v12' as settled.
describe("PROMPT_SET_VERSION (narrowed 'actions.prompt_version carries the set' acceptance)", () => {
  it("is 'v12'", () => {
    expect(PROMPT_SET_VERSION).toBe('v12');
  });
});
