---
title: POC Build — Deploy
status: spark
domain: spark
phase: poc
tags:
- poc
- build-plan
- engine
related:
- '[[poc-build-plan]]'
- '[[poc-tech-stack]]'
---

# POC Build — Deploy

> *Part of [[poc-build-plan]]. LXC provisioning, deployment, tester invite, and observation.*

**Checklist:**

- [ ] Provisioning
- [ ] Invite testers
- [ ] Observe
- [ ] Verdict

---

## Provisioning

- [ ] Create LXC Debian container on host
- [ ] `apt update && apt install nodejs npm git`
- [ ] Create system user for the bot (not root)
- [ ] `git clone` the repo
- [ ] `npm install`
- [ ] Copy `.env` with production credentials
- [ ] `tsx src/index.ts` — verify bot comes online
- [ ] systemd unit file for auto-restart on crash/reboot

## Invite testers

- [ ] Generate Discord bot invite link with required permissions
- [ ] Create test Discord server (or use existing)
- [ ] Invite 8 friends
- [ ] Send welcome message explaining the concept and commands

## Observe

- [ ] Day 1: do they use `/hi` and `/action`?
- [ ] Day 2: do any return without prompting?
- [ ] Do they ask questions about the world?
- [ ] Do the LLM decisions feel interesting or repetitive?
- [ ] Any confusion about commands or flow?
- [ ] Check SQLite: are actions being persisted correctly?
- [ ] Check LLM fallback rate

## Verdict

- [ ] Write 1-paragraph verdict
- [ ] Green light → MVP, or pivot, or retry with changes
- [ ] If green light: write decision record, promote POC docs to `decided`
