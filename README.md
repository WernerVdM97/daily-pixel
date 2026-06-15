# The Warden's Oak

![wardens-oak](./docs/assets/wardens-oak.jpg)

> *A year is a long time to carry an ember. But it's longer still to carry one alone.*

A daily Discord RPG where strangers become a fellowship — decisions, dice rolls, one tree at a crossroads, and trouble waking in the east.

---

## What is this?

The Warden's Oak is a slow-burn narrative game played over a real calendar year. Each day, players get two d20 rolls — more on weekends — to travel, rest, or act, and the world advances around them. Miss a day? Your character rests by the fire. Miss too many? The world moves on without you.

It draws from **Frieren** (time as tension), **D&D** (visible dice), **Lord of the Rings** (fellowship of many), **Castlevania** (gothic threat on the horizon), **anime** (friendship as mechanic), **MapleStory** (the social grind as ritual), and **Fable** (NPCs who live their own lives).

## Visual Guides

 - [gameplay loop](./docs/assets/core-loop.png)
 - [character creation](./docs/assets/character-creation.png)

---

## Roadmap

| Phase    .            | What                                                                         | Status  |
| --------------------- | ---------------------------------------------------------------------------- | ------- |
| **Phase 1<br>Design** | Explore mechanics, engine, UX, and world.                                    | Ongoing |
| **Phase 2<br>POC**    | A bot that rolls dice and shows an ASCII tree.                               | Next    |
| **Phase 3<br>MVP**    | Daily decision leading up to rolls, co-op, NPC basics, weekly rhythm.        | Planned |
| **Phase 4<br>MVP+**   | Year-long campaign. NPC economy, moral drift, LLM narratives, finall climax. | Distant |

## Design docs

The full design vault lives in `docs/` — every idea, mechanic, and decision.

Start with 
- [`docs/README.md`](./docs/README.md) (the map of content), and
- [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) (how docs are organised).

---

## Design principles

- **Cheap by default.** Roll resolution, stat math, and templates run without touching an LLM.
- **Lazy evaluation.** NPCs aren't alive until met. Locations are procedural until visited.
- **Mobile-first Discord.** ~30 char wide ASCII scenes. One message per daily roll batch.
- **Optimised for 8 players.** Thematic choice (a fellowship), not a technical limit.

## Planned architecture

```
Discord Bot (TypeScript)
  ├── Command router
  ├── Daily roll engine
  ├── ASCII art renderer
  ├── Auto-sim engine (PC + NPC)
  ├── NPC routine simulation
  ├── Daily economy tick
  ├── Weekly scheduler (cron)
  │
  ├── Graph DB (SQLite + custom edge model)
  │   └── Nodes: Characters, Locations, NPCs, Items, Quests
  │   └── Edges: trust, rivalry, owns, at_location, on_quest…
  │
  └── LLM Gateway (token-optimized, lazy evaluation)
      └── Narrative generation, NPC dialogue, quest creation
```

---

## License

MIT — see [LICENSE](./LICENSE)
