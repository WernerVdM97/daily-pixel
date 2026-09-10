import { describe, it, expect } from 'vitest';
import {
  classifyBoard,
  formatAge,
  renderBulletin,
  toExcerpt,
  type BoardItem,
  type Comment,
} from '../../scripts/factory-bulletin.js';

function item(over: Partial<BoardItem> & { number: number }): BoardItem {
  return {
    title: `Item ${over.number}`,
    url: `https://example.test/issues/${over.number}`,
    status: 'Inbox',
    priority: 'P2 - normal',
    milestone: 'POC+ arc',
    labels: [],
    ...over,
  };
}

function comment(author: string, createdAt: string, body = 'body'): Comment {
  return { author, createdAt, body };
}

const AGENTS = new Set(['agent97eth']);
const OWNER = 'WernerVdM97';
const NOW = Date.parse('2026-09-10T22:00:00Z');

describe('toExcerpt', () => {
  it('skips the triage boilerplate line and keeps the first real sentence', () => {
    const body = '**Triage: blocked, needs an owner call.**\n\n- `src/llm/` has no tool calling anywhere.';
    expect(toExcerpt(body)).toBe('`src/llm/` has no tool calling anywhere.');
  });

  it('keeps a multi-line comment to its first line, so a table row cannot break', () => {
    expect(toExcerpt('one\ntwo')).toBe('one');
  });

  it('drops a dated header and keeps the question on the same line', () => {
    const body = '**Triage 2026-09-10.** Two asks in one body, and the first cannot be accepted.\n\nMore detail.';
    expect(toExcerpt(body)).toBe('Two asks in one body, and the first cannot be accepted.');
  });

  it('falls back to the header rather than an empty cell when a comment is only boilerplate', () => {
    expect(toExcerpt('**Triage: criteria drafted.**')).toBe('Triage: criteria drafted.');
  });

  it('prefers the marked question over the preamble above it', () => {
    const body = [
      '**Triage 2026-09-10.** Two asks in one body, and the first cannot be accepted yet.',
      '',
      'What is missing: the body never says what a short rest grants.',
      '',
      '**Question:** what does the short rest grant, exactly?',
    ].join('\n');
    expect(toExcerpt(body)).toBe('what does the short rest grant, exactly?');
  });

  it('ignores a bare question marker with nothing after it', () => {
    expect(toExcerpt('**Question:**\n\nThe real preamble.')).toBe('The real preamble.');
  });

  it('escapes a pipe so the cell cannot split into extra columns', () => {
    expect(toExcerpt('either | or')).toBe('either \\| or');
  });

  it('truncates with an ellipsis past the budget', () => {
    const long = 'x'.repeat(200);
    const out = toExcerpt(long, 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('formatAge', () => {
  it('reads as minutes, hours then days', () => {
    expect(formatAge(30_000)).toBe('1m');
    expect(formatAge(3 * 3_600_000)).toBe('3h');
    expect(formatAge(72 * 3_600_000)).toBe('3d');
  });

  it('renders a missing clock as a dash rather than 0m', () => {
    expect(formatAge(null)).toBe('—');
  });
});

describe('classifyBoard', () => {
  const items = [
    item({ number: 1, status: 'Blocked', labels: ['needs-human-decision'] }),
    item({ number: 2, status: 'Blocked', labels: ['needs-human-decision'] }),
    item({ number: 3, status: 'Blocked', labels: ['needs-human-decision'] }),
    item({ number: 4, status: 'Triaged' }),
    item({ number: 5, status: 'In Review' }),
    item({ number: 6, status: 'Approved' }),
    item({ number: 7, status: 'Inbox' }),
  ];

  const classified = classifyBoard(
    items,
    new Map<number, Comment[]>([
      [1, [comment('agent97eth', '2026-09-10T21:00:00Z', '**Triage: blocked, needs an owner call.**\n\nPick a ladder.')]],
      [2, [comment('agent97eth', '2026-09-10T21:00:00Z', 'question'), comment(OWNER, '2026-09-10T21:30:00Z', 'answered it')]],
      [3, []],
      [4, [comment('agent97eth', '2026-09-10T20:00:00Z', '**Triage: criteria drafted.**')]],
    ]),
    { agentLogins: AGENTS, nowMs: NOW },
  );

  it('puts a blocked item with an agent question last on the owner', () => {
    expect(classified.answer.map((e) => e.number)).toEqual([1]);
    expect(classified.answer[0]?.excerpt).toBe('Pick a ladder.');
  });

  it('separates "the human spoke last" from "waiting on the human"', () => {
    expect(classified.answered.map((e) => e.number)).toEqual([2]);
    expect(classified.answered[0]?.excerpt).toBe('answered it');
  });

  it('treats a blocked item with no comments as a defect, not a decision', () => {
    expect(classified.neverAsked.map((e) => e.number)).toEqual([3]);
    expect(classified.answer).toHaveLength(1);
  });

  it('routes Triaged to approve and In Review to merge, ignoring Inbox and Approved', () => {
    expect(classified.approve.map((e) => e.number)).toEqual([4]);
    expect(classified.merge.map((e) => e.number)).toEqual([5]);
    expect(classified.statusCounts).toMatchObject({ Inbox: 1, Approved: 1, Blocked: 3 });
  });

  it('flags an empty Approved column, since the executor can then do nothing', () => {
    const noApproved = classifyBoard([item({ number: 9, status: 'Triaged' })], new Map(), {
      agentLogins: AGENTS,
      nowMs: NOW,
    });
    expect(noApproved.notes.join(' ')).toContain('nothing to pick up');
  });

  it('orders by priority, then oldest first, and sorts an unset priority last', () => {
    const sorted = classifyBoard(
      [
        item({ number: 10, status: 'Triaged', priority: 'P3 - low' }),
        item({ number: 11, status: 'Triaged', priority: null }),
        item({ number: 12, status: 'Triaged', priority: 'P1 - high' }),
        item({ number: 13, status: 'Triaged', priority: 'P1 - high' }),
      ],
      new Map([
        [10, [comment('agent97eth', '2026-09-10T21:00:00Z')]],
        [13, [comment('agent97eth', '2026-09-10T20:00:00Z')]],
        [12, [comment('agent97eth', '2026-09-10T21:30:00Z')]],
      ]),
      { agentLogins: AGENTS, nowMs: NOW },
    );
    expect(sorted.approve.map((e) => e.number)).toEqual([13, 12, 10, 11]);
  });

  it('counts a second login as the factory, so a bot rename does not read as the owner', () => {
    const renamed = classifyBoard(
      [item({ number: 20, status: 'Blocked' })],
      new Map([[20, [comment('factory-bot', '2026-09-10T21:00:00Z', 'still a question')]]]),
      { agentLogins: new Set(['agent97eth', 'factory-bot']), nowMs: NOW },
    );
    expect(renamed.answer.map((e) => e.number)).toEqual([20]);
    expect(renamed.answered).toHaveLength(0);
  });
});

describe('renderBulletin', () => {
  const queue = classifyBoard(
    [
      item({ number: 1, status: 'Blocked', title: 'Waiting item', priority: 'P1 - high' }),
      item({ number: 3, status: 'Blocked', title: 'Questionless item' }),
      item({ number: 4, status: 'Triaged', title: 'Approvable item' }),
    ],
    new Map([[1, [comment('agent97eth', '2026-09-10T21:00:00Z', 'What ladder?')]]]),
    { agentLogins: AGENTS, nowMs: NOW },
  );
  const body = renderBulletin(queue, new Date('2026-09-10T22:00:00Z'));

  it('carries the marker that makes it findable and idempotent', () => {
    expect(body).toContain('<!-- factory-bulletin -->');
    expect(body).toContain('# Dark Factory bulletin');
  });

  it('links every never-asked item so the defect is one click from the fix', () => {
    expect(body).toContain('https://example.test/issues/3');
    expect(body).toContain('Blocked with no question written');
  });

  it('omits sections that have nothing in them', () => {
    expect(body).not.toContain('## Ready to merge');
    expect(body).not.toContain('## Answered, waiting on triage');
  });

  it('always prints the status table, with every flow status present', () => {
    for (const status of ['Inbox', 'Triaged', 'Approved', 'In Progress', 'In Review', 'Blocked', 'Done']) {
      expect(body).toContain(`| ${status} |`);
    }
  });
});
