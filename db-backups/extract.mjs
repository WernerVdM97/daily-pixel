import { openDb } from './_db.mjs';

const { db } = openDb(process.argv[2]);
const line = (s='') => console.log(s);
const H = (s) => { line('\n' + '='.repeat(70)); line(s); line('='.repeat(70)); };

H('FEEDBACK (with character name + date)');
for (const r of db.prepare(`
  SELECT f.id, f.created_at, pc.name, pc.id cid
  FROM feedback f LEFT JOIN player_characters pc ON pc.id=f.character_id
  ORDER BY f.created_at`).all()) {
  const txt = db.prepare('SELECT text FROM feedback WHERE id=?').get(r.id).text;
  line(`#${r.id} [${r.created_at}] ${r.name ?? '(char '+r.cid+')'}:\n    ${txt.replace(/\n/g,'\n    ')}`);
}

H('BUG REPORTS (with character name + date)');
for (const r of db.prepare(`
  SELECT b.id, b.created_at, pc.name, pc.id cid
  FROM bug_reports b LEFT JOIN player_characters pc ON pc.id=b.character_id
  ORDER BY b.created_at`).all()) {
  const txt = db.prepare('SELECT text FROM bug_reports WHERE id=?').get(r.id).text;
  line(`#${r.id} [${r.created_at}] ${r.name ?? '(char '+r.cid+')'}:\n    ${txt.replace(/\n/g,'\n    ')}`);
}

H('ACTION OUTCOME DISTRIBUTION');
for (const r of db.prepare(`SELECT outcome, COUNT(*) n FROM actions GROUP BY outcome ORDER BY n DESC`).all())
  line(`  ${String(r.outcome).padEnd(12)} ${r.n}`);

H('ACTIONS BY prompt_version & app_version');
for (const r of db.prepare(`SELECT app_version, prompt_version, COUNT(*) n FROM actions GROUP BY app_version,prompt_version ORDER BY app_version,prompt_version`).all())
  line(`  app ${String(r.app_version).padEnd(8)} prompt ${String(r.prompt_version).padEnd(6)} ${r.n}`);

H('LLM CALLS — overall health');
const tot = db.prepare('SELECT COUNT(*) n FROM llm_calls').get().n;
line(`total llm_calls: ${tot}`);
line('parse_ok:');
for (const r of db.prepare(`SELECT parse_ok, COUNT(*) n FROM llm_calls GROUP BY parse_ok`).all()) line(`  parse_ok=${r.parse_ok}: ${r.n}`);
line('tier (0=primary,1=fallback):');
for (const r of db.prepare(`SELECT tier, COUNT(*) n FROM llm_calls GROUP BY tier`).all()) line(`  tier=${r.tier}: ${r.n}`);
line('finish_reason:');
for (const r of db.prepare(`SELECT finish_reason, COUNT(*) n FROM llm_calls GROUP BY finish_reason`).all()) line(`  ${r.finish_reason}: ${r.n}`);
line('http_status:');
for (const r of db.prepare(`SELECT http_status, COUNT(*) n FROM llm_calls GROUP BY http_status`).all()) line(`  ${r.http_status}: ${r.n}`);
line('models:');
for (const r of db.prepare(`SELECT model, COUNT(*) n FROM llm_calls GROUP BY model`).all()) line(`  ${r.model}: ${r.n}`);

H('LLM CALLS WITH ERRORS');
for (const r of db.prepare(`SELECT id, created_at, prompt_version, model, tier, http_status, finish_reason, error FROM llm_calls WHERE error IS NOT NULL ORDER BY created_at`).all())
  line(`  #${r.id} [${r.created_at}] pv=${r.prompt_version} tier=${r.tier} http=${r.http_status} finish=${r.finish_reason}\n      ERROR: ${r.error}`);

H('LLM CALLS — parse failures (parse_ok=0)');
for (const r of db.prepare(`SELECT id, created_at, prompt_version, model, tier, http_status, finish_reason, player_input FROM llm_calls WHERE parse_ok=0 ORDER BY created_at`).all())
  line(`  #${r.id} [${r.created_at}] pv=${r.prompt_version} tier=${r.tier} http=${r.http_status} finish=${r.finish_reason}\n      input: ${String(r.player_input).slice(0,160)}`);

H('LLM CALLS — validation warnings (non-empty)');
for (const r of db.prepare(`SELECT id, created_at, prompt_version, validation_warnings, player_input FROM llm_calls WHERE validation_warnings IS NOT NULL AND validation_warnings NOT IN ('[]','') ORDER BY created_at`).all())
  line(`  #${r.id} [${r.created_at}] pv=${r.prompt_version}\n      warnings: ${r.validation_warnings}\n      input: ${String(r.player_input).slice(0,140)}`);

H('TOKEN & LATENCY STATS (successful primary calls)');
const stats = db.prepare(`SELECT COUNT(*) n, AVG(total_tokens) at, MAX(total_tokens) mt, AVG(latency_ms) al, MAX(latency_ms) ml, AVG(reasoning_chars) ar, MAX(reasoning_chars) mr FROM llm_calls WHERE parse_ok=1`).get();
line(JSON.stringify(stats, null, 2));
line('\nslowest 8 calls:');
for (const r of db.prepare(`SELECT id, created_at, latency_ms, total_tokens, reasoning_chars, model, tier FROM llm_calls ORDER BY latency_ms DESC LIMIT 8`).all())
  line(`  #${r.id} ${r.latency_ms}ms tokens=${r.total_tokens} reasoning_chars=${r.reasoning_chars} model=${r.model} tier=${r.tier}`);
