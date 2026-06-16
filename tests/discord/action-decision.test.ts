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

describe('buildDecisionMessage — DC display & passive-insight colouring', () => {
  const SUCCESS = 3; // ButtonStyle.Success
  const SECONDARY = 2; // ButtonStyle.Secondary

  const decision = {
    prompt: 'A fork in the road.',
    options: [
      { label: 'Easy path', dcModifier: -2 },
      { label: 'Hard path', dcModifier: 4 },
      { label: 'Step back', dcModifier: null },
    ],
  };
  const state = { rawInput: 'go east', decisions: [], accumulatedDc: 12 };

  it('shows the effective DC (running DC + modifier) per option when state is present', () => {
    const msg = buildDecisionMessage(decision, 0, state);
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('DC 10'); // 12 - 2
    expect(desc).toContain('DC 16'); // 12 + 4
  });

  it('tints achievable options green when passive insight (10 + WIS) meets the DC', () => {
    // WIS 2 → passive insight 12. Easy path DC 10 ≤ 12 (favourable); hard path DC 16 > 12.
    const char = { stats: { physical: 0, wisdom: 2, intelligence: 0, charisma: 0 } };
    const msg = buildDecisionMessage(decision, 0, state, char);
    const btns = buttons(msg);
    expect(btns[0].style).toBe(SUCCESS);   // Easy path — within reach
    expect(btns[1].style).toBe(SECONDARY); // Hard path — not sensed as favourable
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('🟢');
  });

  it('gives no green hints to a character with low wisdom', () => {
    // WIS -1 → passive insight 9, below both DCs.
    const char = { stats: { physical: 0, wisdom: -1, intelligence: 0, charisma: 0 } };
    const msg = buildDecisionMessage(decision, 0, state, char);
    const btns = buttons(msg);
    expect(btns[0].style).toBe(SECONDARY);
    expect(btns[1].style).toBe(SECONDARY);
  });

  it('renders the quoted quest path separate from the current scene', () => {
    const msg = buildDecisionMessage(decision, 1, {
      rawInput: 'hunt the stag', decisions: [{ prompt: 'p', chosen: 'Track it', dcModifier: -1 }], accumulatedDc: 11,
    });
    const desc = (msg.embeds[0] as any).description as string;
    expect(desc).toContain('> 🧭 **Quest:** hunt the stag');
    expect(desc).toContain('> ↳ *Track it*');
  });
});
