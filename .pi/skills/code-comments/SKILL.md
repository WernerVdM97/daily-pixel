---
name: code-comments
description: How to comment source in The Warden's Oak — when a comment is warranted, the 1-2 line budget, and the banned kinds (issue refs, decision narration, cross-layer duplication, echo comments). Use when writing or reviewing any comment or JSDoc block in src/ or tests/.
allowed-tools: Read, Edit, Grep, Glob
---

# Code Comments

The rule is in `AGENTS.md`: **code is the source of truth for what it does, and a comment earns its place only by saying what the code cannot, in 1 or 2 lines.** This skill is the worked-example half of it.

Unnarrated source is a project goal, not a preference. Every extra line of prose is a line a reviewer has to read, hold and then check against the code, and a line that drifts the moment the code moves.

## The test to apply

Ask: *could a competent reader get this from the code itself, from `git blame`, or from the PR?* If yes, delete it. If no, keep it and keep it to the point.

## Banned

### 1. Issue and board references

```ts
// BAD
// #97: the opening round authors the fight's `baseDc`, and the edge pins it from here on.
baseDc: state.lastDecideResult.baseDc,
```

`#97` means nothing to a reader in the file, and the card it points at will be closed and forgotten while the line stays. The commit subject (`fix(#97): …`) and the PR body carry that link; they are one `git log` away and they travel with the change.

### 2. Decision narration

```ts
// BAD — eight lines explaining a board card's reasoning
// The fight's OWN dc (#97): authored by the opening round's decide beat and pinned on the
// `in_combat` edge from then on, so `enemyBonus`, the combat card's `dangerTier` and the
// `foeDanger` RESOLVE is handed all describe the same foe in every round of one fight. The
// decide model is free to re-author `baseDc` on a CONTINUE round (nothing clamps it), and
// reading it here lets the foe's to-hit bonus and its displayed tier drift mid-fight for no
// in-world reason. ...
const fightDc = cs.baseDc ?? state.lastDecideResult.baseDc;

// GOOD — the one genuinely non-obvious consequence, two lines
// The fallback covers an edge written before the prop existed; folding it back into `cs` is
// what bounds it to a single round.
const fightDc = cs.baseDc ?? state.lastDecideResult.baseDc;
if (cs.baseDc === undefined) cs = { ...cs, baseDc: fightDc };
```

The commit body is where the *why we changed it* lives, in as much depth as it needs. The code only needs the *why it looks like this*.

### 3. The same rationale at several layers

This is the single most common failure, and the most expensive to review: one decision restated in the type doc, the producer, the reader, the validator, the prompt builder and the test. It reads as six independent justifications for six unrelated lines, so each has to be checked against the code separately even though it is one fact stated six times.

State it **once**, at the layer a reader debugging that behaviour would actually open. Everywhere else, the name should carry it: `baseDc` on the edge, `dc` on the round summary.

### 4. Echo comments

```ts
// BAD — restates the next line
// Push the fight DC onto the round summary.
out.push(`- Fight DC: ${dc} (fixed when the fight opened; any baseDc you author is ignored)`);

// GOOD — no comment at all; the emitted string says exactly what it means, to the model
out.push(`- Fight DC: ${dc} (the fight's own DC, fixed when it opened; any baseDc you author is ignored)`);
```

### 5. Line-number citations into other files

`// see combat-state.ts:118` is correct until the next edit above line 118, and nothing fails when it goes wrong. Cite the symbol instead, or nothing.

## Carve-outs

Warranted, and still kept brief:

- **Exported helper usage doc.** What the helper is for and how to call it, when the signature alone does not say (units, ordering expectations, which of two similar helpers to reach for).
- **Test and fixture notes.** The scenario a fixture builds: the dice it feeds, the HP it starts from, what authors what, and why it is shaped that way. Setup is not self-evident from the assertions, and a test whose setup is unexplained is a test nobody dares change. Keep it to the fixture it describes.
- **A non-obvious constant or threshold**, with where the number came from.
- **An ordering, idempotency or persistence caveat** that bites if missed.
- **A broken convention**, or a deliberate exception to a pattern.

## Reviewing a diff for this

Raise as a *style* finding, never a blocking one: `#NNN` references, decision narration, a rationale repeated at more than one layer, echo comments, any comment block over two lines, and cross-file line-number citations.

Do not raise the carve-outs: a helper's usage doc, or a test fixture documenting its own setup. Documenting a test's scenario is not slop; it is the thing that makes the test maintainable.
