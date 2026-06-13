---
title: Hazard Map — No-Gos, Rabbit Holes, Risks
status: exploring
domain: game
tags: [scope, risks, no-gos, rabbit-holes, discipline]
related:
  - "[[core-loop]]"
  - "[[architecture]]"
---

## Hazard Map

### No-Gos

| Item | Why |
|------|-----|
| **Real-time combat** | Discord latency + mobile = terrible UX. All combat is roll-resolution, not twitch. |
| **Voice chat integration** | Scope creep. Text-only. |
| **Persistent inventory menus** | Discord buttons have limits. Keep interactions to text commands and simple reactions. |
| **Multi-party simultaneous events** | Token budget killer. One scene at a time, queued. |
| **Procedural world generation mid-year** | The world must feel *built*, not generated. Pre-seed locations, let the AI reveal them. |
| **Player-driven economy / crafting system** | This is a narrative game, not an MMO. Keep items meaningful and rare. |

### Rabbit Holes

| Hole | Risk | Mitigation |
|------|------|------------|
| **"Let's make the AI smarter"** | Endless prompt engineering. Token budget blows up. | Ship with dumb-but-charming AI. Improve only if engagement survives Month 1. |
| **"One more NPC system"** | Faction reputation, romance arcs, betrayal mechanics — each is a subsystem. | Start with 1 NPC depth mechanic (trust). Add only if the first one lands. |
| **"The ASCII engine should animate"** | Frame-by-frame animation in Discord text is possible but dev-heavy. | Static scenes first. "Animation" is scene-to-scene transition. |
| **"Full Fable economy simulation"** | Property ownership, rent collection, regional trade route optimization, NPC business competition — each is a subsystem. | Light economy only: jobs, income, prosperity drift, simple supply/demand. The economy is flavor, not a spreadsheet. Add depth only if the POC survives Month 3. |
| **"Let's support 20+ players"** | Graph DB and token budget don't scale linearly. | Hard cap at 8. If the POC works, the sequel campaign can be designed for scale. |
| **"Balancing classes and stats"** | D&D-style class balance is an infinite timesink. | 3–4 broad archetypes (Warrior, Ranger, Sage, Rogue). No subclasses. Stats are simple. |
| **"The graph DB should be Neo4j/ArangoDB"** | Operational overhead for a POC with 8 players. | SQLite with a custom edge table. Migrate to a real graph DB only if it survives Month 3. |

### Known Risks

| Risk | Likelihood | Impact | Response |
|------|-----------|--------|----------|
| Player drop-off after 2 weeks | High | Fellowship feels thin, narrative loses momentum | Auto-sim keeps absent characters in the world. Death at 3 weeks is the hard reset — the story "eats" the dropout. |
| LLM API costs exceed budget | Medium | Game pauses or degrades | Lazy evaluation + caching is the primary defense. Fallback: template-only mode (no LLM) for weekdays, LLM only on weekends. |
| Discord rate limits on mobile | Low | Messages delayed or dropped | Batch daily-roll results into 1–2 messages max. No rapid-fire updates. |
| 1 year is too long | Medium | Engagement cliff around Month 4–6 | Mid-year event (June/July) as a mini-climax. The threat sends a herald. A character may die unavoidably. Raise the stakes. |
