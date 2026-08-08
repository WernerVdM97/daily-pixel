import { describe, it, expect } from 'vitest';

import { SessionController } from '../../src/controller/SessionController.js';
import { MockWorldEngine } from '../../src/engine/MockWorldEngine.js';
import { WizardSession } from '../../src/discord/WizardSession.js';
import type { CharDefs } from '../../src/controller/joinWizard.js';

// M7.3: the controller requires the wizard deps at every construction site — this suite
// never touches the wizard, so the store is fresh and the defs empty.
const EMPTY_DEFS: CharDefs = { classes: [], backgrounds: [], races: [], alignments: [], dayJobs: [], itemSets: [] };

// M8.1 (DC-M8.5): the controller's 7th constructor arg (openLook's scene renderer) — a
// fixed stub; this suite never reaches openLook.
const SCENE_STUB = () => ({ sceneName: "test", ascii: "..." });

// ── M3.1 — pins the controller seam: `feedbackConfirmation` is a pure function of the
// surface (so it can be shown BEFORE the best-effort persist), and `recordFeedback` routes
// each surface to the right engine call with the right arg count, matching the four
// pre-M3.1 dispatchInteraction.ts leaves exactly. ──

describe('SessionController — feedbackConfirmation', () => {
  const controller = new SessionController(new MockWorldEngine(), () => 'A quiet clearing under the oak.', [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);

  it('returns the sleep-feedback copy', () => {
    expect(controller.feedbackConfirmation('sleep')).toEqual({
      screen: 'notice',
      text: '🙏 Thanks. The warden listens.',
      ephemeral: true,
    });
  });

  it('returns the release-feedback copy', () => {
    expect(controller.feedbackConfirmation('release')).toEqual({
      screen: 'notice',
      text: '🙏 Noted. The warden carries your words forward.',
      ephemeral: true,
    });
  });

  it('returns the outcome-feedback copy', () => {
    expect(controller.feedbackConfirmation('outcome-feedback')).toEqual({
      screen: 'notice',
      text: '🙏 Thanks. The warden listens.',
      ephemeral: true,
    });
  });

  it('returns the outcome-bug copy', () => {
    expect(controller.feedbackConfirmation('outcome-bug')).toEqual({
      screen: 'notice',
      text: '🐛 Bug noted. The warden will investigate.',
      ephemeral: true,
    });
  });
});

// ── beginCustomAction (DC-M9.2 fix): the pre-port `commands/action.ts:67` top guard
// (rollsRemaining <= 0 && !lastActionState) never crossed the seam — moved behind the
// controller. Guard order: char guard -> resume-in-progress -> rolls -> start. ──

describe('SessionController — beginCustomAction', () => {
  it('returns no-rolls when out of rolls with no pending action', () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter({ id: 1, rollsRemaining: 0, lastActionState: null }));
    const controller = new SessionController(engine, () => 'A quiet clearing under the oak.', [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);

    expect(controller.beginCustomAction('user-1')).toEqual({ kind: 'no-rolls' });
  });

  it('still resumes a mid-action character with 0 rolls remaining — NOT no-rolls (the regression a naive fix would reintroduce)', () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter({ id: 1, rollsRemaining: 0, lastActionState: '{...}' as never }));
    engine.setResumeResult({
      state: { rawInput: 'scout the ridge', decisions: [], accumulatedDc: 12 } as never,
      nextDecision: {
        prompt: 'The ridge forks ahead.',
        options: [
          { label: 'Climb', dcModifier: 2 },
          { label: 'Step back', dcModifier: null },
        ],
      },
    });
    const controller = new SessionController(engine, () => 'A quiet clearing under the oak.', [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);

    const result = controller.beginCustomAction('user-1');

    expect(result.kind).toBe('resume');
    expect(engine.calls.resumeAction).toContain(1);
  });
});

describe('SessionController — recordFeedback', () => {
  it('routes sleep/release to submitFeedback with no actionId', () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter({ id: 1 }));
    const controller = new SessionController(engine, () => 'A quiet clearing under the oak.', [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);

    controller.recordFeedback('sleep', 'user-1', 'loving the atmosphere');
    controller.recordFeedback('release', 'user-1', 'more day jobs please');

    expect(engine.calls.submitFeedback).toEqual([
      { characterId: 1, text: 'loving the atmosphere', actionId: undefined },
      { characterId: 1, text: 'more day jobs please', actionId: undefined },
    ]);
    expect(engine.calls.submitBug).toEqual([]);
  });

  it('routes outcome-feedback to submitFeedback with the actionId', () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter({ id: 1 }));
    const controller = new SessionController(engine, () => 'A quiet clearing under the oak.', [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);

    controller.recordFeedback('outcome-feedback', 'user-1', 'good fight', 42);

    expect(engine.calls.submitFeedback).toEqual([
      { characterId: 1, text: 'good fight', actionId: 42 },
    ]);
    expect(engine.calls.submitBug).toEqual([]);
  });

  it('routes outcome-bug to submitBug with the actionId', () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter({ id: 1 }));
    const controller = new SessionController(engine, () => 'A quiet clearing under the oak.', [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);

    controller.recordFeedback('outcome-bug', 'user-1', 'the door is stuck', 7);

    expect(engine.calls.submitBug).toEqual([
      { characterId: 1, text: 'the door is stuck', actionId: 7 },
    ]);
    expect(engine.calls.submitFeedback).toEqual([]);
  });

  it('is a no-op when the user has no character', () => {
    const engine = new MockWorldEngine();
    const controller = new SessionController(engine, () => 'A quiet clearing under the oak.', [], undefined, new WizardSession(), EMPTY_DEFS, SCENE_STUB);

    controller.recordFeedback('sleep', 'unknown-user', 'hello?');

    expect(engine.calls.submitFeedback).toEqual([]);
    expect(engine.calls.submitBug).toEqual([]);
  });
});
