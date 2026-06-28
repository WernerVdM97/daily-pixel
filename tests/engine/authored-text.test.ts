import { describe, it, expect } from 'vitest';
import { sanitizeAuthored } from '../../src/engine/authored-text.js';

describe('sanitizeAuthored', () => {
  it('leaves clean prose untouched', () => {
    expect(sanitizeAuthored("Town Square")).toBe("Town Square");
    expect(sanitizeAuthored("The Shrine of the First Flame")).toBe("The Shrine of the First Flame");
    expect(sanitizeAuthored("O'Malley's Rest-Stop, pt. 2!")).toBe("O'Malley's Rest-Stop, pt. 2!");
  });

  it('strips markdown / section / mention control chars', () => {
    expect(sanitizeAuthored("**The** Void")).toBe("The Void");
    expect(sanitizeAuthored("## Hidden Path")).toBe("Hidden Path");
    expect(sanitizeAuthored("a `code` _span_ ~x~ |bar| [link] <@123>")).toBe("a code span x bar link @123");
  });

  it('collapses newlines and whitespace runs into single spaces', () => {
    expect(sanitizeAuthored("a\n\n###  fake\tsection")).toBe("a fake section");
  });

  it('caps length and never leaves a trailing space from the slice', () => {
    const out = sanitizeAuthored("word ".repeat(40), 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out).toBe("word word wo".trimEnd());
    expect(out.endsWith(" ")).toBe(false);
  });

  it('reduces an all-control-char name to empty (caller drops it)', () => {
    expect(sanitizeAuthored("***")).toBe("");
    expect(sanitizeAuthored("   ")).toBe("");
  });
});
