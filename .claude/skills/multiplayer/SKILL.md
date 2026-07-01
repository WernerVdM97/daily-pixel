---
name: multiplayer
description: Co-op multiplayer principles for a server-authoritative, async/turn-based game. Use when designing co-op architecture, state sync, server authority, or anything touching multi-player consistency.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Multiplayer Game Development

> Networking architecture and synchronization principles.

---

## 1. Architecture Selection

### Decision Tree

```
What type of multiplayer?
│
├── Competitive / Real-time
│   └── Dedicated Server (authoritative)
│
├── Cooperative / Casual
│   └── Host-based (one player is server)
│
├── Turn-based
│   └── Client-server (simple)        ← this game
│
└── Massive (MMO)
    └── Distributed servers
```

This game is **co-op + turn-based**: one authoritative server (the Discord bot + graph DB) owns all state; Discord is the client. There is no live session to host — just scheduled ticks — so it gets dedicated-server *authority* at near-zero hosting cost.

### Comparison

| Architecture | Latency | Cost | Security |
|--------------|---------|------|----------|
| **Dedicated** | Low | High | Strong |
| **P2P** | Variable | Low | Weak |
| **Host-based** | Medium | Low | Medium |

---

## 2. Synchronization Principles

### State vs Input

| Approach | Sync What | Best For |
|----------|-----------|----------|
| **State Sync** | Game state | Simple, few objects |
| **Input Sync** | Player inputs | Action games |
| **Hybrid** | Both | Most games |

This game is **State Sync** — the graph *is* the state, and a tick simply produces the next state. (The source's *lag compensation* — prediction, interpolation, reconciliation, hit-rewind — does not apply: nothing happens between ticks, so there is no lag to hide.)

---

## 3. Security Principles

### Server Authority

```
Client: "I rolled a 20 and looted the sword"
Server: Validate → did the roll engine actually produce that result?
         → was the PC in a valid state/location to act?
         → does the item exist and belong here?
```

The bot rolls the dice and owns the graph; a client can never assert an outcome.

### Anti-Cheat

| Cheat | Prevention |
|-------|------------|
| Forged roll | Server rolls; clients never submit results |
| Item dupe | Server owns inventory (graph edges) |
| Acting while lost/dead | Server validates PC state before any action |

(Real-time exploits — speed hacks, aimbots, wall hacks — don't exist in a turn-based text game.)

---

## 4. Anti-Patterns

| ❌ Don't | ✅ Do |
|----------|-------|
| Trust the client | Server is authority |
| Let a client submit a roll or result | Server rolls and validates |
| Send everything every tick | Deliver only what changed, batched into 1-2 messages |

---

> **Remember:** Never trust the client. The server is the source of truth.
