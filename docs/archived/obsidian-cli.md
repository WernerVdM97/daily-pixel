---
title: Obsidian CLI
status: nogo
domain: archived
tags:
- engine
- vault
related:
- '[[CONVENTIONS]]'
phase: nogo
---

# Obsidian CLI

Obsidian CLI (`obsidian`) exposes vault operations — read, write, search, frontmatter, tags, tasks — from the terminal. Anything the GUI can do, the CLI can do, plus dev commands (`eval`, `devtools`, `plugin:reload`).

## Why it matters for this vault

- **Automate convention checks**: validate `title`/`status`/`domain` frontmatter on every doc; catch missing fields before they become slop.
- **Auto-generate the map of content**: script the `docs/README.md` status table by querying frontmatter across the vault.
- **Programmatic search**: find all `status: nogo` docs, orphaned `[[wikilinks]]`, or files with a given tag.
- **Agentic access via MCP**: the `obsidian-cli-rest` community plugin turns CLI commands into an HTTP API + MCP server — letting AI agents (or scripts) interact with the vault. Could wire Pi into the vault directly.

## Quick reference

```bash
# Search by frontmatter
obsidian search query="status::spark" format=json

# Find unresolved links
obsidian unresolved

# List all tags with counts
obsidian tags counts

# Files in a folder
obsidian files folder="docs/sparks" limit=50

# Read a file's properties (frontmatter)
obsidian properties file="sparks/obsidian-cli"
```

## Open questions / scope

- Is Obsidian CLI stable enough to depend on for vault tooling?
- What's the install story on Linux (this dev machine)?
- Would the MCP plugin (`obsidian-cli-rest`) be worth setting up, or overkill for a solo vault?
- Where would automation scripts live? `scripts/` at repo root? Inside `agent/`?

## Potential automations

| What | Command / approach |
|---|---|
| Frontmatter lint | `obsidian search` + grep for missing required fields |
| README status table | script that queries `status::*` per domain folder, generates markdown rows |
| Orphan doc finder | `obsidian unresolved` — surface docs missing from README |
| Tag inventory | `obsidian tags counts` — spot tag drift |
| Pre-commit hook | run frontmatter lint on staged `.md` files |
