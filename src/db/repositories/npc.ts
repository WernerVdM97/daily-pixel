import type Database from 'better-sqlite3';
import type { NpcRow } from './types.js';

export type { NpcRow };

export class NpcRepository {
  constructor(private db: Database.Database) {}

  create(data: {
    name: string;
    class?: string;
    race?: string;
    dayJob?: string;
    stats?: string;
    health?: number;
    stamina?: number;
    wealth?: number;
    location?: string;
    description?: string;
    createdByActionId: number;
  }): NpcRow {
    const stmt = this.db.prepare(`
      INSERT INTO npcs (name, class, race, day_job, stats, health, stamina, wealth, location, description, created_by_action_id)
      VALUES (@name, @class, @race, @day_job, @stats, @health, @stamina, @wealth, @location, @description, @created_by_action_id)
    `);
    const result = stmt.run({
      name: data.name,
      class: data.class ?? null,
      race: data.race ?? null,
      day_job: data.dayJob ?? null,
      stats: data.stats ?? null,
      health: data.health ?? null,
      stamina: data.stamina ?? null,
      wealth: data.wealth ?? 0,
      location: data.location ?? null,
      description: data.description ?? null,
      created_by_action_id: data.createdByActionId,
    });
    return this.db
      .prepare('SELECT * FROM npcs WHERE id = ?')
      .get(result.lastInsertRowid) as NpcRow;
  }

  findByCharacterActions(characterId: number): NpcRow[] {
    return this.db
      .prepare(`
        SELECT npcs.* FROM npcs
        JOIN actions ON npcs.created_by_action_id = actions.id
        WHERE actions.character_id = ?
        ORDER BY npcs.id DESC
      `)
      .all(characterId) as NpcRow[];
  }

  findByLocation(location: string): NpcRow[] {
    return this.db
      .prepare('SELECT * FROM npcs WHERE location = ?')
      .all(location) as NpcRow[];
  }

  updateLocation(id: number, location: string): void {
    this.db
      .prepare('UPDATE npcs SET location = ? WHERE id = ?')
      .run(location, id);
  }
}
