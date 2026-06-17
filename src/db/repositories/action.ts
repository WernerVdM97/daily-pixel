import type Database from 'better-sqlite3';
import type { ActionRow } from './types.js';

export type { ActionRow };

export class ActionRepository {
  constructor(private db: Database.Database) {}

  create(data: {
    characterId: number;
    rawInput: string;
    type: string;
    decisionsJson: string;
    finalDc: number;
    playerRolled: number | null;
    outcome: string;
    appVersion?: string | null;
    promptVersion?: string;
    /** JSON array of the mutations actually applied (post-validation, post-failure-strip). */
    appliedMutations?: string | null;
  }): ActionRow {
    // Per-call LLM audit now lives in the llm_calls table (linked via action_id);
    // the legacy llm_request/llm_response columns are left NULL.
    const stmt = this.db.prepare(`
      INSERT INTO actions (character_id, raw_input, type, decisions_json, final_dc, player_rolled, outcome, app_version, prompt_version, applied_mutations)
      VALUES (@character_id, @raw_input, @type, @decisions_json, @final_dc, @player_rolled, @outcome, @app_version, @prompt_version, @applied_mutations)
    `);
    const result = stmt.run({
      character_id: data.characterId,
      raw_input: data.rawInput,
      type: data.type,
      decisions_json: data.decisionsJson,
      final_dc: data.finalDc,
      player_rolled: data.playerRolled,
      outcome: data.outcome,
      app_version: data.appVersion ?? null,
      prompt_version: data.promptVersion ?? 'v1',
      applied_mutations: data.appliedMutations ?? null,
    });
    const row = this.db
      .prepare('SELECT * FROM actions WHERE id = ?')
      .get(result.lastInsertRowid) as ActionRow;
    return row;
  }

  findRecentByCharacterId(characterId: number, limit = 5): ActionRow[] {
    return this.db
      .prepare(
        'SELECT * FROM actions WHERE character_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(characterId, limit) as ActionRow[];
  }
}
