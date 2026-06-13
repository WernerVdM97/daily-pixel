---
title: "Render Strategy: ASCII for POC, PNG/MP4 deferred"
status: spark
domain: spark
tags:
  - decision
  - render
  - ascii
  - png
  - mp4
  - scope
related:
  - "[[mvp-ascii-render-pipeline]]"
  - "[[render-engine-estimates]]"
phase: poc
---

# Decision: Render Strategy

## Context

Two render docs appeared to contradict each other:

- **[[mvp-ascii-render-pipeline]]** (`decided`) scopes the visual layer as **ASCII-only** in Discord code blocks, and explicitly lists PNG generation and video/MP4 as *out of scope*.
- **[[render-engine-estimates]]** (`spark`) measures **server-side PNG and MP4** file sizes against Discord upload limits — exactly the thing the pipeline doc rules out.

Left unreconciled, this is the textbook slop pattern: two docs pulling opposite directions with no record of which wins.

## Decision

They aren't actually in conflict — they sit at **different stages**, so we make that explicit:

- **POC = ASCII only.** The confirmed render path is the ASCII pipeline. Build against it now. Black-and-white in code blocks, no server-side image/video generation.
- **PNG/MP4 = deferred exploration (MVP+).** The size estimates are a *reference* for a possible richer-visual upgrade once the POC proves engagement. They are not a commitment and nothing in the POC depends on them.

## Consequences

- `ascii-render-pipeline` stays `decided` — it is the POC contract.
- `render-engine-estimates` stays `spark` — explicitly a future option, not the current direction. (Promote to `exploring` only if/when we actually pursue rich visuals.)
- Colour output and any PNG/MP4 work do not enter scope until a follow-up decision reopens this.

## Revisit when

The POC survives early engagement and we want richer visuals than ASCII can carry — at which point write a successor decision and promote the estimates doc.
