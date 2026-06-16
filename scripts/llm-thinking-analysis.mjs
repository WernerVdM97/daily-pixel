#!/usr/bin/env node
/**
 * Longest-thinking LLM call analysis.
 *
 * Pulls the 5 rows with the largest thinking (reasoning_chars) and displays
 * the request context + LLM response so you (or an agent) can diagnose what
 * the model is tripping over.
 *
 * Usage:
 *   node scripts/llm-thinking-analysis.mjs                     # default: top 5
 *   node scripts/llm-thinking-analysis.mjs 10                  # top 10
 *   node scripts/llm-thinking-analysis.mjs 5  --include-think  # include full thinking text (big output)
 *
 * Ordering within results: prompt_version DESC, app_version DESC, reasoning_chars DESC.
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'warden.db');

// ── CLI ────────────────────────────────────────────────────────────────────
const LIMIT = process.argv[2] ? parseInt(process.argv[2], 10) : 5;
const INCLUDE_THINK = process.argv.includes('--include-think');

// ── Query ──────────────────────────────────────────────────────────────────
const db = new Database(dbPath, { readonly: true });

/**
 * Step 1: get the top N rows by reasoning_chars (largest thinking first).
 * Step 2: re-order those rows by (prompt_version DESC, app_version DESC, reasoning_chars DESC).
 *
 * We need a stable ordering, so we union the top-N ids and then join back.
 */
const sql = `
WITH top_n AS (
  SELECT id
  FROM llm_calls
  ORDER BY reasoning_chars DESC NULLS LAST
  LIMIT ?
)
SELECT
  lc.id,
  lc.prompt_version,
  lc.app_version,
  lc.model,
  lc.temperature,
  lc.tier,
  lc.player_input,
  lc.context_digest,
  lc.raw_prompt,
  lc.reasoning,
  lc.reasoning_chars,
  lc.response_json,
  lc.parse_ok,
  lc.validation_warnings,
  lc.error,
  lc.http_status,
  lc.prompt_tokens,
  lc.completion_tokens,
  lc.total_tokens,
  lc.latency_ms,
  lc.finish_reason,
  lc.created_at
FROM llm_calls lc
JOIN top_n tn ON tn.id = lc.id
ORDER BY
  lc.prompt_version DESC,
  lc.app_version DESC,
  lc.reasoning_chars DESC
`;

const rows = db.prepare(sql).all(LIMIT);
db.close();

if (rows.length === 0) {
  console.log('No LLM calls found in the database.');
  process.exit(0);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function heading(text) {
  const line = '─'.repeat(text.length + 4);
  console.log(`\n┌${line}┐`);
  console.log(`│  ${text}  │`);
  console.log(`└${line}┘`);
}

function kv(key, value) {
  const v = value ?? '(null)';
  console.log(`  ${key.padEnd(22)} ${v}`);
}

function section(title, body) {
  console.log(`\n  ${title}`);
  if (body) {
    console.log(body.replace(/^/gm, '    '));
  }
}

function truncate(str, max = 200) {
  if (!str) return;
  if (str.length <= max) return str;
  return str.slice(0, max) + ` … [truncated — ${str.length} total chars]`;
}

function formatTimestamp(ts) {
  if (!ts) return '(null)';
  const d = new Date(ts + 'Z');
  return d.toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC';
}

// ── Render ─────────────────────────────────────────────────────────────────
console.log(`\n══════════════  TOP ${LIMIT} LLM CALLS BY THINKING SIZE  ══════════════`);
console.log(`  (ordered by prompt_version↓, app_version↓, reasoning_chars↓)\n`);

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const rank = i + 1;

  heading(`#${rank}  •  ID ${r.id}  •  ${r.reasoning_chars.toLocaleString()} chars thinking`);

  // ── Metadata ─────────────────────────────────────────────────────────────
  section('── Metadata ──');
  kv('Row ID', r.id);
  kv('Prompt version', r.prompt_version);
  kv('App version', r.app_version ?? '(null — ancient row)');
  kv('Model', r.model);
  kv('Temperature', r.temperature);
  kv('Tier', r.tier === 0 ? 'primary' : `fallback (${r.tier})`);
  kv('Created', formatTimestamp(r.created_at));
  kv('Latency', r.latency_ms ? `${r.latency_ms} ms` : '(null)');
  kv('Tokens (prompt)', r.prompt_tokens?.toLocaleString() ?? '(null)');
  kv('Tokens (completion)', r.completion_tokens?.toLocaleString() ?? '(null)');
  kv('Tokens (total)', r.total_tokens?.toLocaleString() ?? '(null)');
  kv('Finish reason', r.finish_reason ?? '(null)');
  kv('Parse OK', r.parse_ok ? '✅ yes' : '❌ no');
  kv('HTTP status', r.http_status ?? '(null)');
  kv('Error', r.error ?? '(none)');
  kv('Warnings', r.validation_warnings && r.validation_warnings !== '[]' ? r.validation_warnings : '(none)');

  // ── Request context ──────────────────────────────────────────────────────
  section('── Request (player input + context digest) ──');

  if (r.raw_prompt) {
    // Full raw prompt was captured (diagnostic call — golden).
    section('📦 raw_prompt (full):', r.raw_prompt);
  } else {
    // Reconstruct from what we have.
    console.log('  (raw_prompt not stored — this was a successful primary call)');
  }

  section('🧑 player_input:', `"${r.player_input ?? '(null)'}"`);

  if (r.context_digest) {
    try {
      const ctx = JSON.parse(r.context_digest);
      console.log(`  location:        ${ctx.location}`);
      console.log(`  NPCs nearby:     ${ctx.npcs?.join(', ') ?? '(none)'}  (${ctx.npc_rows ?? 0} raw rows)`);
      console.log(`  PCs nearby:      ${ctx.pcs ?? 0}`);
      console.log(`  recent actions:  ${ctx.recent?.join('; ') ?? '(none)'}`);
      console.log(`  scaling hint:    ${ctx.has_scaling ? 'yes' : 'no'}`);
      console.log(`  prev decisions:  ${ctx.prev_decisions ?? 0}`);
    } catch {
      console.log(`  (raw): ${r.context_digest}`);
    }
  }

  // ── Thinking ─────────────────────────────────────────────────────────────
  if (r.reasoning && INCLUDE_THINK) {
    section('💭 LLM thinking (reasoning):', r.reasoning);
  } else if (r.reasoning_chars) {
    console.log(`\n  💭 ${r.reasoning_chars.toLocaleString()} chars of thinking (use --include-think to show full text)`);
  }

  // ── Response ─────────────────────────────────────────────────────────────
  section('── Response (LLM output) ──');

  if (r.response_json) {
    try {
      const parsed = JSON.parse(r.response_json);
      console.log(`  prompt:         ${truncate(String(parsed.prompt ?? ''), 300)}`);
      console.log(`  distilled_type: ${parsed.distilled_type ?? '(null)'}`);
      console.log(`  stat:           ${parsed.stat ?? '(null)'}`);
      console.log(`  base_dc:        ${parsed.base_dc ?? '(null)'}`);
      console.log(`  required:       ${parsed.required ?? '(null)'}`);
      console.log(`  done:           ${parsed.done ?? '(null)'}`);

      if (parsed.decision && Array.isArray(parsed.decision)) {
        console.log(`  decision (${parsed.decision.length} options):`);
        for (const opt of parsed.decision) {
          const dc = opt.dc_modifier === null ? 'bail' : `dc_mod ${opt.dc_modifier}`;
          console.log(`    • "${truncate(String(opt.label ?? ''), 200)}"  (${dc})`);
        }
      }

      if (parsed.mutations && Array.isArray(parsed.mutations)) {
        console.log(`  mutations (${parsed.mutations.length}):`);
        for (const m of parsed.mutations) {
          console.log(`    • ${JSON.stringify(m)}`);
        }
      }

      if (parsed.outcome_text) {
        console.log(`  outcome_text:   ${truncate(String(parsed.outcome_text), 300)}`);
      }

      // Full raw JSON as a compact block for agents to parse
      console.log(`\n  raw_json: ${JSON.stringify(parsed)}`);

    } catch {
      // Not valid JSON? Show plain text.
      console.log(`  (not valid JSON — raw follows)\n${r.response_json}`);
    }
  } else {
    console.log('  (no response stored — call likely failed)');
  }
}

console.log(`\n═══════════════════════════════════════════════════════════════\n`);
