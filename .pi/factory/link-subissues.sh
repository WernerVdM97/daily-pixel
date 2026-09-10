#!/usr/bin/env bash
# Link sub-issues on the Dark Factory board, per the TODO.md structure (2026-08-02, 5f76cb5).
# Reviewed and approved mapping. Idempotent-ish: re-running re-links (GitHub rejects dupes).
set -euo pipefail
REPO="WernerVdM97/daily-pixel"

link() { # link <parent#> <child#>
  # REST API wants the numeric database id, not the node id, and it must be a JSON integer
  local child_id
  child_id=$(gh api "repos/$REPO/issues/$2" --jq .id)
  printf '{"sub_issue_id": %s}' "$child_id" \
    | gh api -X POST "repos/$REPO/issues/$1/sub_issues" --input - --jq '.number' >/dev/null \
    && echo "  #$2 -> #$1"
}

echo "Linking sub-issues..."
# 85 LLM prompt architecture refactor <- the mvp-llm-prompt-architecture cluster
link 85 27
link 85 60
link 85 63
link 85 65
link 85 70

# 86 Combat as a core mechanic <- POC+ combat stages + the deferred death track
link 86 33
link 86 41
link 86 44

# 87 Graph DB for backend coherency <- schema/world data-model follow-throughs
link 87 82
link 87 68

# 88 Introduce and reuse NPCs more often <- npc-economy follow-through
link 88 67

# 89 Rethink sleep mechanic / world-state projection <- rest + engine-owned routing
link 89 37
link 89 81

# 91 ANSI engine rewrite <- the mobile-images precursor
link 91 56

# 98 Opening-frame runtime gaps (new parent) <- ANSI-F review residuals
link 98 40
link 98 43
link 98 46
link 98 61

# 99 M4 smoke-run findings (new parent) <- the 2026-07-21 review
link 99 47
link 99 49
link 99 52

echo "Done. #90 (scrape prettier ascii art) stays flat, no evidence of children."