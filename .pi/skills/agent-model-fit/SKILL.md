---
name: agent-model-fit
description: How to judge whether each Dark Factory agent is pinned to the right model, from its measured token shape rather than from headline prices. Use when asked to evaluate agent/model fit, whether a model swap would pay, or what a new model would cost per agent.
allowed-tools: Read, Bash, Grep, Glob
paths:
  - .pi/agents/**
  - scripts/factory-friction.ts
---

# Agent/model fit

Every pin in `.pi/agents/` is one line. The question is never "is this model good", it is "does this model's rate shape match this agent's token shape". Get the shape first, then price.

## 1. Read the shape

```bash
npx tsx scripts/factory-friction.ts --since 92d --by-agent
```

Per agent: `prompt` (input + cached), `cached%`, `output`. Derive two numbers:

- **out/prompt**: output+reasoning ÷ prompt. This is the whole argument.
- **cached%**: how much of the read is served at the cache-read rate.

## 2. Price in the right order

Columns are priced independently and the order is not intuitive:

1. **output** is 44 to 74% of a judgement loop's bill on 1 to 4% of the tokens, because DeepSeek's output rate is 200x its cache-read rate.
2. **cache read** is 6 to 32%.
3. **headline input** is 13 to 19%, except on the starter and the scheduler wrapper, whose prefixes never warm (59 to 61%).

A cheap headline input over a poor cache-read or output rate is the wrong pick. `hy4-flash` is the only candidate that wins every column.

## 3. Score the swap

A rival that is dearer on cache and input but cheaper on output wins above:

```
r* = (cache premium × cached% + input premium × (1 − cached%)) / output saving
```

Against DeepSeek off-peak that puts `ling-3.1-flash` at **1.2 to 1.8%** and `glm-5.3-flash` at **4.1 to 4.8%**. Measured ratios: triage 3.97, scrumo 3.92, sweeper 3.14, reviewer 2.70, fixer 2.06, meta-oil 1.64, executor 1.26, librarian 0.77. So output-heavy loops are where a cache-poor model earns its place, and reading-heavy loops never are.

## 4. Three traps

- **Peak doubles DeepSeek's columns only**, so every rival threshold collapses (GLM Flash fell from 4.5% to 1.2%). Schedule changes can invalidate a pin decision.
- **A cached% gap of one or two points is noise**, not a signal. Work in cash: the reviewer's cache spend is lower than the executor's despite caching slightly worse.
- **Rate shape is not capability.** `modelFamily`, gpqa, tau and the AA indices come from the benchmarks API; a model can fit the arithmetic perfectly and still be wrong. No pin moves on price alone until it has benchmark rows.

Report the shape table, the one line of arithmetic that decides each candidate, and the verdict per agent: appropriate, overkill, or underspecced.
