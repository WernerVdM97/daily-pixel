import { describe, it, expect } from 'vitest';
import { buildDecisionMessage } from '../../src/discord/commands/action.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
function buttons(msg: ReturnType<typeof buildDecisionMessage>): any[] {
  return msg.components.flatMap((r: any) => r.components);
}

describe('buildDecisionMessage — A/B/C buttons', () => {
  it('lists real options as lettered body lines; bail is not lettered', () => {
    const msg = buildDecisionMessage({
      prompt: 'A wolf blocks the path.',
      options: [
        { label: 'Track the wolf quietly', dcModifier: -2 },
        { label: 'Charge in', dcModifier: 2 },
        { label: 'Step back', dcModifier: null },
      ],
    }, 0);

    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('**A.** Track the wolf quietly');
    expect(desc).toContain('**B.** Charge in');
    expect(desc).not.toContain('Step back'); // terminal option lives on the button only
  });

  it('labels real-option buttons A/B and keeps a worded bail button', () => {
    const msg = buildDecisionMessage({
      prompt: 'x',
      options: [
        { label: 'Track the wolf quietly', dcModifier: -2 },
        { label: 'Charge in', dcModifier: 2 },
        { label: 'Step back', dcModifier: null },
      ],
    }, 0);

    expect(buttons(msg).map(b => b.label)).toEqual(['A', 'B', 'Step back']);
  });

  it('maps each letter button to its original option index (resolution depends on this)', () => {
    const msg = buildDecisionMessage({
      prompt: 'x',
      options: [
        { label: 'first', dcModifier: 0 },
        { label: 'second', dcModifier: -1 },
        { label: 'Bail', dcModifier: null },
      ],
    }, 2);

    const btns = buttons(msg);
    expect(btns[0].custom_id).toBe('action:choice:2:0');
    expect(btns[1].custom_id).toBe('action:choice:2:1');
    expect(btns[2].custom_id).toBe('action:bail');
  });
});
