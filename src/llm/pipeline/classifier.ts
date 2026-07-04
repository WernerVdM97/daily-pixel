import type { ActionType, ClassifyResult, RoutingFlags } from './types.js';
import type { LlmContext } from '../LlmGateway.js';

/** One category's recognizer: any pattern matching is enough to count as a candidate. Kept as
 *  arrays (not a single alternation) so entries stay readable and independently testable. */
interface CategoryTable {
  actionType: ActionType;
  patterns: RegExp[];
}

// Deliberately no shared keywords across tables (e.g. "explore" reads as travel-ish AND
// search-ish, so it's left out entirely) — an input matching more than one table is exactly
// the ambiguous case that must miss rather than guess (see heuristicClassify below).
const CATEGORY_TABLES: CategoryTable[] = [
  {
    actionType: 'rest',
    patterns: [/\b(rest|sleep|nap|recover|camp|relax|recuperate)\b/i],
  },
  {
    actionType: 'travel',
    patterns: [
      /\b(travel|journey|venture|hike|trek|wander|walk|ride|sail|march|return)\s+(to|toward|towards|into|down|up|back)\b/i,
      /\b(go|head|move)\s+(to|toward|towards|into|north|south|east|west)\b/i,
      /\bcross\s+(the\s+)?(frontier|border|river|bridge)\b/i,
      /\bset\s+off\s+for\b/i,
    ],
  },
  {
    actionType: 'combat',
    patterns: [
      /\b(attack|fight|strike|kill|slay|stab|shoot|battle|duel|ambush|charge at|swing at|draw\s+(my\s+)?(sword|weapon|blade))\b/i,
    ],
  },
  {
    actionType: 'social',
    patterns: [
      /\b(talk|speak|chat|flirt)\s+(to|with)\b/i,
      /\b(persuade|negotiate|greet|convince|bribe|intimidate|charm|barter\s+with|trade\s+with|ask)\b/i,
    ],
  },
  {
    actionType: 'skill',
    patterns: [
      /\b(pick\s+the\s+lock|craft|brew|forge|repair|build|climb|pray|meditate|study|train|tinker|carve|cook|heal|bandage)\b/i,
    ],
  },
  {
    actionType: 'search',
    patterns: [
      /\b(search|investigate|scavenge|forage|loot|rummage|scout|examine|inspect)\b/i,
      /\blook\s+for\b/i,
      /\bdig\s+(through|around|for)\b/i,
    ],
  },
];

// A rough textual danger signal only — not the authoritative `location.isSafe` that decide/
// resolve read from `LlmContext`. Good enough to bias classify-time pacing flags; real safety
// checks happen once the pipeline has world context.
const UNSAFE_LOCATION_PATTERN =
  /\b(dungeon|cave|catacombs?|ruins|wilds|wilderness|abyss|depths|enemy camp|crypt|lair|nest)\b/i;

// Targeted-at-someone/something phrasing: a preposition immediately before a noun phrase.
// Deliberately loose — a false positive here only means `target_present` is set on an
// untargeted action, which is a routing nicety, not a correctness hazard like a wrong ActionType.
const TARGET_PATTERN = /\b(?:at|to|with|on)\s+(?:the\s+|a\s+|an\s+|my\s+)?[a-z][\w'-]*/i;

// Direct-object phrasing ("attack the goblin", "search the room") never has a preposition
// before the noun, so it's checked as a separate OR'd pattern rather than folded into
// TARGET_PATTERN above — a determiner anywhere in the input is enough given the flag is
// already documented as loose/best-effort (see comment above).
const DETERMINER_NOUN_PATTERN = /\b(?:the|a|an|my|that|this)\s+[a-z][\w'-]*/i;

// Negation flips a candidate category hit into a miss: "don't attack" is not combat intent,
// but the bare-keyword tables above have no way to see that on their own — see the guard in
// heuristicClassify below.
const NEGATION_PATTERN =
  /\b(don't|do not|doesn't|won't|will not|never|refuse to|cannot|can't|shouldn't|wouldn't)\b/i;

// Idioms that collide with a category table's bare keywords (e.g. combat's "kill"/"shoot")
// without expressing that category's intent at all — enumerated explicitly rather than
// guessed at, since idiom detection can't be done reliably with a general pattern.
const IDIOM_MISS_PATTERNS: RegExp[] = [/\bkill time\b/i, /\bshoot the breeze\b/i, /\bwalk away from\b/i];

// Only combat/social/skill/search actions can plausibly resolve on a dice roll in this
// prototype; rest and travel are treated as deterministic outcomes until Stage 2 proves
// otherwise (e.g. a risky frontier crossing) — see plan doc's scope fence on per-type shapes.
const ROLL_ACTION_TYPES = new Set<ActionType>(['combat', 'social', 'skill', 'search']);

function deriveFlags(actionType: ActionType, rawInput: string): RoutingFlags {
  return {
    unsafe_location: UNSAFE_LOCATION_PATTERN.test(rawInput),
    needs_roll: ROLL_ACTION_TYPES.has(actionType),
    target_present: TARGET_PATTERN.test(rawInput) || DETERMINER_NOUN_PATTERN.test(rawInput),
  };
}

/**
 * Heuristic CLASSIFY stage (Stage 1 settled decision #3): a wide regex/ngram table maps short
 * free-text input to an `ActionType` + routing flags at zero LLM cost. Matching more than one
 * category, or none, is genuinely ambiguous — returns a typed miss rather than guessing, so
 * the caller can fall through to the LLM classify-fallback seam (`PipelineLlmGateway.classify`).
 *
 * Pure and synchronous by design: CLASSIFY fires once per action, before any LLM context is
 * assembled (pipeline contract, plan doc line ~28-32).
 */
export function heuristicClassify(rawInput: string): ClassifyResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { kind: 'miss', rawInput };
  }

  const matches = CATEGORY_TABLES.filter((table) => table.patterns.some((pattern) => pattern.test(trimmed)));

  if (matches.length !== 1) {
    return { kind: 'miss', rawInput };
  }

  // A single-table match can still be wrong: negation ("don't attack") reverses the bare
  // keyword's intent, and some idioms ("kill time") collide with a table's keyword without
  // carrying that category's meaning at all. Both are known-wrong-guess shapes, not merely
  // ambiguous ones, so they miss here rather than falling into the ambiguity check above.
  if (NEGATION_PATTERN.test(trimmed) || IDIOM_MISS_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { kind: 'miss', rawInput };
  }

  const actionType = matches[0].actionType;
  return { kind: 'hit', actionType, flags: deriveFlags(actionType, trimmed) };
}

/**
 * Seam for Task 1: a typed stand-in for the LLM classify-fallback. A real fallback call is
 * explicitly out of scope for Stage 1 (plan doc's scope fence) — the sim scripts this hook
 * deterministically instead. Throwing here (rather than returning a canned hit) is intentional:
 * a caller that reaches this without swapping in a scripted/real implementation has a wiring
 * bug, and a fallback that silently guesses would violate "never guess wrong".
 */
export async function notImplementedClassifyFallback(rawInput: string, _context: LlmContext): Promise<never> {
  throw new Error(
    `notImplementedClassifyFallback: heuristic classify missed on "${rawInput}" and no LLM fallback is wired up ` +
      '(Stage 1 scope fence — sim scripts this seam, see PipelineLlmGateway.classify).',
  );
}
