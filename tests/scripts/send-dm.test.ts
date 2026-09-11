import { describe, expect, it } from 'vitest';
import {
  EMBED_LIMITS,
  composeMessage,
  contentLengthError,
  embedError,
  parseEmbeds,
} from '../../scripts/send-dm';

// The limits are Discord's, not ours: every one of them fails the whole send when exceeded,
// and the API error names neither the embed nor the field. These tests pin the contract so a
// digest that outgrows a field is caught here rather than silently losing its proposals.
describe('message content limits', () => {
  it('accepts content at the cap and refuses one character past it', () => {
    expect(contentLengthError('x'.repeat(2000))).toBeNull();
    expect(contentLengthError('x'.repeat(2001))).toContain('2001 characters');
    expect(contentLengthError('x'.repeat(2001))).toContain("Discord's limit is 2000");
  });
});

describe('embed limits', () => {
  const field = (name: string, value: string) => ({ name, value });

  it('accepts a well-formed embed', () => {
    expect(
      embedError([
        {
          title: 'meta-oil survey',
          description: 'window 09-07 to 09-11',
          fields: [field('1. Stop counting a fork', 'signal: tool-error 113x/21')],
          footer: { text: '263.6M tok' },
        },
      ]),
    ).toBeNull();
  });

  it('treats an empty embed list as nothing to send', () => {
    expect(embedError([])).toBeNull();
  });

  it('refuses anything that is not an array of objects', () => {
    expect(embedError({ title: 'not an array' })).toContain('must be an array');
    expect(embedError([null])).toContain('embed 1 is not an object');
    expect(embedError([{ title: 'ok' }, 'nope'])).toContain('embed 2 is not an object');
  });

  it('names the field that overflowed, not just the embed', () => {
    const over = embedError([{ fields: [field('1. ok', 'x'.repeat(1025))] }]);
    expect(over).toContain('embed 1 field 1 value is 1025 characters');
    expect(over).toContain("Discord's limit is 1024");
  });

  it('checks each part against its own limit', () => {
    expect(embedError([{ title: 'x'.repeat(257) }])).toContain('title is 257');
    expect(embedError([{ description: 'x'.repeat(4097) }])).toContain('description is 4097');
    expect(embedError([{ author: { name: 'x'.repeat(257) } }])).toContain('author name is 257');
    expect(embedError([{ footer: { text: 'x'.repeat(2049) } }])).toContain('footer is 2049');
    expect(embedError([{ fields: [field('x'.repeat(257), 'ok')] }])).toContain('field 1 name is 257');
  });

  it('caps the field count and the embed count', () => {
    const fields = Array.from({ length: 26 }, (_, i) => field(`f${i}`, 'v'));
    expect(embedError([{ fields }])).toContain('field count is 26');
    expect(embedError([{ fields: fields.slice(0, 25) }])).toBeNull();

    const embeds = Array.from({ length: 11 }, () => ({ description: 'x' }));
    expect(embedError(embeds)).toContain('embed count is 11');
    expect(embedError(embeds.slice(0, 10))).toBeNull();
  });

  it('caps the aggregate across every embed in the message', () => {
    // 6000 is the whole message's budget, not a per-embed one.
    expect(embedError([{ description: 'x'.repeat(3000) }, { description: 'x'.repeat(3000) }])).toBeNull();
    const over = embedError([{ description: 'x'.repeat(3001) }, { description: 'x'.repeat(3000) }]);
    expect(over).toContain('embeds in total is 6001');
    expect(over).toContain("Discord's limit is 6000");
  });

  it('counts a title, footer and field names toward the aggregate too', () => {
    const big = { name: 'x'.repeat(256), value: 'v'.repeat(1024) };
    const embeds = Array.from({ length: 5 }, () => ({ fields: [big] }));
    // 5 x (256 + 1024) = 6400, over the aggregate, with no single part over its own limit.
    expect(embedError(embeds)).toContain('in total is 6400');
  });
});

describe('parsing an --embed file', () => {
  it('takes one object or an array, and always yields an array', () => {
    expect(parseEmbeds('{"description":"one"}', 'e.json')).toHaveLength(1);
    expect(parseEmbeds('[{"description":"one"},{"description":"two"}]', 'e.json')).toHaveLength(2);
  });

  it('names the source when the file is not JSON, or is over a limit', () => {
    expect(() => parseEmbeds('{oops', 'digest.json')).toThrow(/digest\.json is not valid JSON/);
    expect(() => parseEmbeds('{"description":"x"}', 'digest.json')).not.toThrow();
    expect(() => parseEmbeds(`{"title":"${'x'.repeat(257)}"}`, 'digest.json')).toThrow(
      /digest\.json: embed 1 title is 257 characters/,
    );
  });
});

describe('composing the message', () => {
  it('stays a bare string when there is no embed, so a plain caller is unchanged', () => {
    expect(composeMessage('just text', undefined)).toBe('just text');
    expect(composeMessage('just text', [])).toBe('just text');
  });

  it('carries content and embeds together, with an empty content when there is no body', () => {
    const embed = { description: 'a card' };
    expect(composeMessage('the index', [embed])).toEqual({ content: 'the index', embeds: [embed] });
    expect(composeMessage(undefined, [embed])).toEqual({ content: '', embeds: [embed] });
  });
});

// The shape meta-oil's role definition prescribes: content is the index, the embed carries one
// field per proposal. This pins the design's numbers, so a proposal template that quietly grew
// past a field limit fails here instead of losing a proposal at the API.
describe('the meta-oil digest shape', () => {
  const content = [
    '**🛢️ meta-oil survey** · Fri 11 Sep, 20:00',
    '**Signals** tool-error 113x/21 (97% of tokens) · file-rework 25x/14 · owner-correction 3x/3',
    '**Window** 09-07 → 09-11 · 50 sessions · 113 failed calls of 3171 · 71 distinct',
    '[friction report](…) · [factory spec](…)',
    '**Open** 3 pending, oldest 2d (#1) · [PR #115](…) applied',
    'React 1/2/3 · ✅ · ❌ · 🔁 · ⏸ · or reply in text',
  ].join('\n');

  const proposal = (n: number) => ({
    name: `${n}. Stop counting a fork's replay of its parent in the friction ranking`,
    value: [
      '**signal** tool-error 113x/21, 97% of the window’s tokens',
      '**why** 10 fork transcripts replay their parent; 31 of the 113 failures are 6 events counted up to 10x',
      '**files** [factory-friction.ts](https://github.com/WernerVdm97/daily-pixel/blob/dev/scripts/factory-friction.ts), [CHANGELOG.md](https://github.com/WernerVdm97/daily-pixel/blob/dev/CHANGELOG.md)',
      '**diff** skip entries whose `id` is in an ancestor `parentSession`; add `--errors [n]`',
      '**verify** tool-error ~82 next window',
      '**blast** rankings only, no code path reads it',
    ].join('\n'),
  });

  const embeds = [
    {
      title: '🔧 meta-oil survey · 09-07 → 09-11',
      color: 0xdaa520,
      description: '• no python3 `yaml` (js-yaml is present) · • a job worktree carries no `.env`',
      fields: [1, 2, 3, 4, 5].map(proposal),
      footer: { text: '40 owner + 10 fork sessions · 263.6M tok · $23.51' },
    },
  ];

  it('fits the content budget with room to spare', () => {
    expect(content.length).toBeLessThan(900);
    expect(contentLengthError(content)).toBeNull();
  });

  it('fits five six-field proposals inside one embed', () => {
    expect(embedError(embeds)).toBeNull();
    for (const field of embeds[0].fields) {
      expect(field.value.length).toBeLessThan(EMBED_LIMITS.fieldValue);
      expect(field.name.length).toBeLessThan(EMBED_LIMITS.fieldName);
    }
  });

  it('keeps the whole digest well inside the aggregate, so there is room to grow', () => {
    const aggregate = content.length + JSON.stringify(embeds).length;
    expect(aggregate).toBeLessThan(4000);
  });
});
