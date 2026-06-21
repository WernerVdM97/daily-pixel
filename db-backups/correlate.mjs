import { openDb } from './_db.mjs';

const { db } = openDb(process.argv[2]);
const line = (s='') => console.log(s);
const H = (s) => { line('\n' + '='.repeat(70)); line(s); line('='.repeat(70)); };

H('VALIDATION WARNINGS by app_version (is it fixed in latest?)');
for (const r of db.prepare(`
  SELECT app_version, COUNT(*) n
  FROM llm_calls
  WHERE validation_warnings IS NOT NULL AND validation_warnings NOT IN ('[]','')
  GROUP BY app_version ORDER BY app_version`).all())
  line(`  app ${String(r.app_version).padEnd(8)} warnings: ${r.n}`);

line('\ntotal calls per app_version (for rate):');
for (const r of db.prepare(`SELECT app_version, COUNT(*) n FROM llm_calls GROUP BY app_version ORDER BY app_version`).all())
  line(`  app ${String(r.app_version).padEnd(8)} calls: ${r.n}`);

H('"done" (auto-resolve) outcomes — version, date, input, mutations');
for (const r of db.prepare(`
  SELECT id, created_at, app_version, prompt_version, raw_input, final_dc, player_rolled, applied_mutations, narrative
  FROM actions WHERE outcome='done' ORDER BY created_at`).all()) {
  line(`  #${r.id} [${r.created_at}] app=${r.app_version} pv=${r.prompt_version} dc=${r.final_dc} rolled=${r.player_rolled}`);
  line(`      input: ${String(r.raw_input).slice(0,120)}`);
  line(`      mutations: ${String(r.applied_mutations).slice(0,160)}`);
  line(`      narrative: ${String(r.narrative ?? '').slice(0,160)}`);
}

H('Outcome distribution per app_version');
for (const r of db.prepare(`SELECT app_version, outcome, COUNT(*) n FROM actions GROUP BY app_version, outcome ORDER BY app_version, n DESC`).all())
  line(`  app ${String(r.app_version).padEnd(8)} ${String(r.outcome).padEnd(12)} ${r.n}`);

H('timed_out / bailed actions detail');
for (const r of db.prepare(`SELECT id, created_at, app_version, outcome, raw_input FROM actions WHERE outcome IN ('timed_out','bailed') ORDER BY created_at`).all())
  line(`  #${r.id} [${r.created_at}] app=${r.app_version} ${r.outcome}: ${String(r.raw_input).slice(0,120)}`);

H('Latency distribution buckets (all calls)');
for (const r of db.prepare(`
  SELECT CASE
    WHEN latency_ms < 5000 THEN '0-5s'
    WHEN latency_ms < 10000 THEN '5-10s'
    WHEN latency_ms < 20000 THEN '10-20s'
    WHEN latency_ms < 30000 THEN '20-30s'
    ELSE '30s+' END bucket, COUNT(*) n
  FROM llm_calls GROUP BY bucket ORDER BY MIN(latency_ms)`).all())
  line(`  ${r.bucket.padEnd(8)} ${r.n}`);

H('Day-by-day activity (engagement / retention signal)');
for (const r of db.prepare(`SELECT substr(created_at,1,10) d, COUNT(DISTINCT character_id) players, COUNT(*) actions FROM actions GROUP BY d ORDER BY d`).all())
  line(`  ${r.d}  players=${r.players}  actions=${r.actions}`);

H('Per-character activity (last_played, total actions)');
for (const r of db.prepare(`
  SELECT pc.name, pc.location, pc.health, pc.max_health, pc.rolls_remaining, pc.last_played_at,
    (SELECT COUNT(*) FROM actions a WHERE a.character_id=pc.id) acts
  FROM player_characters pc ORDER BY pc.last_played_at DESC`).all())
  line(`  ${String(r.name).padEnd(20)} loc=${String(r.location).padEnd(16)} hp=${r.health}/${r.max_health} rolls=${r.rolls_remaining} acts=${r.acts} last=${r.last_played_at}`);
