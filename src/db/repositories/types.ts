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
  max_stamina: number;
  rolls_remaining: number;
  location: string;
  wealth: number;
  last_action_state: string | null;
  last_played_at: string | null;
  last_rested_day: number | null;
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
  app_version: string | null;
  prompt_version: string;
  narrative: string | null;
  /** @deprecated superseded by the llm_calls table; unwritten since v4. */
  llm_request: string | null;
  /** @deprecated superseded by the llm_calls table; unwritten since v4. */
  llm_response: string | null;
  /** JSON array of the world mutations actually applied (post-validation,
   *  post-failure-strip). NULL for rows written before this column existed. */
  applied_mutations: string | null;
  created_at: string;
}

export interface LlmCallRow {
  id: number;
  action_id: number | null;
  app_version: string | null;
  prompt_version: string;
  model: string;
  temperature: number | null;
  tier: number;
  player_input: string | null;
  context_digest: string | null;     // JSON
  raw_prompt: string | null;         // diagnostic calls only
  reasoning: string | null;          // diagnostic calls only
  response_json: string | null;
  parse_ok: number;                   // 0|1
  validation_warnings: string | null; // JSON array
  error: string | null;
  http_status: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  reasoning_chars: number | null;
  latency_ms: number | null;
  finish_reason: string | null;
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
  created_by_action_id: number | null;
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
