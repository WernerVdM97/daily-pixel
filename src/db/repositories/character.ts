import type Database from 'better-sqlite3';
import type { CharacterRow } from './types.js';

export type { CharacterRow };

type CreateInput = Omit<CharacterRow, 'id' | 'user_id' | 'created_at' | 'last_played_at' | 'last_rested_day'> & {
  created_at?: string;
};

type UpdateInput = Partial<Omit<CharacterRow, 'id' | 'user_id' | 'created_at'>>;

export class CharacterRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(userId: number, data: Omit<CreateInput, 'created_at'>): CharacterRow {
    const stmt = this.db.prepare(`
      INSERT INTO player_characters (
        user_id, name, class, upbringing, race, alignment, day_job,
        stats, health, max_health, stamina, max_stamina, rolls_remaining,
        location, wealth, last_action_state
      ) VALUES (
        @user_id, @name, @class, @upbringing, @race, @alignment, @day_job,
        @stats, @health, @max_health, @stamina, @max_stamina, @rolls_remaining,
        @location, @wealth, @last_action_state
      )
    `);
    const params = {
      user_id: userId,
      name: data.name,
      class: data.class,
      upbringing: data.upbringing,
      race: data.race,
      alignment: data.alignment,
      day_job: data.day_job,
      stats: data.stats,
      health: data.health ?? 10,
      max_health: data.max_health ?? 10,
      stamina: data.stamina ?? 10,
      max_stamina: data.max_stamina ?? 10,
      rolls_remaining: data.rolls_remaining ?? 3,
      location: data.location ?? "The Warden's Oak",
      wealth: data.wealth ?? 0,
      last_action_state: data.last_action_state ?? null,
    };
    const result = stmt.run(params);
    return {
      id: result.lastInsertRowid as number,
      user_id: userId,
      ...data,
      health: params.health,
      max_health: params.max_health,
      stamina: params.stamina,
      max_stamina: params.max_stamina,
      rolls_remaining: params.rolls_remaining,
      location: params.location,
      wealth: params.wealth,
      last_action_state: params.last_action_state,
      last_played_at: null,
      last_rested_day: null,
      created_at: this.getCreatedAt(result.lastInsertRowid as number),
    };
  }

  findByUserId(userId: number): CharacterRow | undefined {
    return this.db
      .prepare('SELECT * FROM player_characters WHERE user_id = ?')
      .get(userId) as CharacterRow | undefined;
  }

  findAll(): CharacterRow[] {
    return this.db
      .prepare('SELECT * FROM player_characters ORDER BY id')
      .all() as CharacterRow[];
  }

  findById(id: number): CharacterRow | undefined {
    return this.db
      .prepare('SELECT * FROM player_characters WHERE id = ?')
      .get(id) as CharacterRow | undefined;
  }

  /** Count player characters whose `last_played_at` is on/after `startIso`. Lexical
   *  compare of 'YYYY-MM-DD HH:MM:SS' >= 'YYYY-MM-DD', so a 'YYYY-MM-DD' boundary
   *  includes exactly that day's engagements (a '2026-08-05 00:00:00' stamp counts,
   *  a '2026-08-04 23:59:59' one does not). NULL `last_played_at` never matches. */
  countActiveSince(startIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM player_characters WHERE last_played_at >= ?')
      .get(startIso) as { n: number };
    return Number(row.n);
  }

  update(id: number, fields: UpdateInput): void {
    const allowed = [
      'name', 'class', 'upbringing', 'race', 'alignment', 'day_job',
      'stats', 'health', 'max_health', 'stamina', 'max_stamina', 'rolls_remaining',
      'location', 'wealth', 'last_action_state', 'last_played_at', 'last_rested_day',
      'last_noop_refund_day', 'last_timeout_refund_day', 'last_bail_refund_day',
    ];
    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id };

    for (const key of allowed) {
      if (key in fields) {
        setClauses.push(`${key} = @${key}`);
        values[key] = (fields as Record<string, unknown>)[key];
      }
    }

    if (setClauses.length === 0) return;

    this.db
      .prepare(`UPDATE player_characters SET ${setClauses.join(', ')} WHERE id = @id`)
      .run(values);
  }

  private getCreatedAt(id: number): string {
    return (this.db.prepare('SELECT created_at FROM player_characters WHERE id = ?').get(id) as { created_at: string }).created_at;
  }
}
