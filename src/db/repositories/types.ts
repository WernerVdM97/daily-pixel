// Row types for all 9 tables — plain shapes matching schema.sql

export interface UserRow {
  id: number;
  discord_user_id: string;
  created_at: string;
}

export interface CharacterRow {
  id: number;
  user_id: number;
  name: string;
  class: string;
  upbringing: string;
  race: string;
  alignment: string;
  day_job: string;
  stats: string;              // JSON
  health: number;
  max_health: number;
  stamina: number;
  rolls_remaining: number;
  location: string;
  wealth: number;
  last_action_state: string | null;
  created_at: string;
}

export interface ActionRow {
  id: number;
  character_id: number;
  raw_input: string;
  type: string;
  decisions_json: string;     // JSON
  final_dc: number;
  player_rolled: number | null;
  outcome: string;
  created_at: string;
}

export interface ItemRow {
  id: number;
  character_id: number;
  name: string;
  emoji: string;
  stat: string;
  modifier: number;
  quantity: number;
}

export interface NpcRow {
  id: number;
  name: string;
  class: string | null;
  race: string | null;
  day_job: string | null;
  stats: string | null;       // JSON
  health: number | null;
  stamina: number | null;
  wealth: number;
  location: string | null;
  description: string | null;
  created_by_action_id: number;
}

export interface LocationRow {
  id: number;
  name: string;
  description: string | null;
  tags: string | null;
  is_safe: number;            // 0|1
}

export interface FeedbackRow {
  id: number;
  character_id: number;
  text: string;
  created_at: string;
}

export interface BugReportRow {
  id: number;
  character_id: number;
  text: string;
  created_at: string;
}

export interface MetaRow {
  key: string;
  value: string;
}
