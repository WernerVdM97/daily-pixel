export interface LlmContext {
  character: {
    class: string;
    stats: { physical: number; wisdom: number; intelligence: number; charisma: number };
    health: number;
    stamina: number;
    alignment: string;
    dayJob: string;
  };
  location: { name: string };
  nearbyNpcs: { name: string; description: string }[];
  nearbyPcs: { name: string; class: string }[];
  recentActions: { type: string; outcome: string }[];
  rawInput: string;
  previousDecisions?: { prompt: string; chosen: string; dcModifier: number }[];
  scalingHint: string;
}

export interface LlmDecision {
  distilledType: string;
  stat: 'physical' | 'wisdom' | 'intelligence' | 'charisma';
  baseDc: number;
  required: boolean;
  done: boolean;
  decision: LlmDecisionOption[];
  mutations?: unknown[];
  outcomeText?: string;
}

export interface LlmDecisionOption {
  label: string;
  dcModifier: number | null; // null = bail
}

export interface LlmGateway {
  decide(context: LlmContext): Promise<LlmDecision>;
}
