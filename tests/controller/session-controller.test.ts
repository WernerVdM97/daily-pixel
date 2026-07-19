import { describe, it, expect } from 'vitest';

import { SessionController } from '../../src/controller/SessionController.js';
import { MockWorldEngine } from '../../src/engine/MockWorldEngine.js';

// ── M3.1 — pins the controller seam: `feedbackConfirmation` is a pure function of the
// surface (so it can be shown BEFORE the best-effort persist), and `recordFeedback` routes
// each surface to the right engine call with the right arg count, matching the four
// pre-M3.1 dispatchInteraction.ts leaves exactly. ──

describe('SessionController — feedbackConfirmation', () => {
  const controller = new SessionController(new MockWorldEngine());

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

describe('SessionController — recordFeedback', () => {
  it('routes sleep/release to submitFeedback with no actionId', () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter({ id: 1 }));
    const controller = new SessionController(engine);

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
    const controller = new SessionController(engine);

    controller.recordFeedback('outcome-feedback', 'user-1', 'good fight', 42);

    expect(engine.calls.submitFeedback).toEqual([
      { characterId: 1, text: 'good fight', actionId: 42 },
    ]);
    expect(engine.calls.submitBug).toEqual([]);
  });

  it('routes outcome-bug to submitBug with the actionId', () => {
    const engine = new MockWorldEngine();
    engine.setCharacter(MockWorldEngine.defaultCharacter({ id: 1 }));
    const controller = new SessionController(engine);

    controller.recordFeedback('outcome-bug', 'user-1', 'the door is stuck', 7);

    expect(engine.calls.submitBug).toEqual([
      { characterId: 1, text: 'the door is stuck', actionId: 7 },
    ]);
    expect(engine.calls.submitFeedback).toEqual([]);
  });

  it('is a no-op when the user has no character', () => {
    const engine = new MockWorldEngine();
    const controller = new SessionController(engine);

    controller.recordFeedback('sleep', 'unknown-user', 'hello?');

    expect(engine.calls.submitFeedback).toEqual([]);
    expect(engine.calls.submitBug).toEqual([]);
  });
});
