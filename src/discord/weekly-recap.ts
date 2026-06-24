import type { RecapGateway, RecapResult } from "../llm/LlmGateway.js";
import type { WeeklyActionSummary } from "../engine/WorldEngine.js";
import { c } from "../util/colors.js";

// ── meta keys (freeform key-value store) ──
/** Current week's thread id — where action outcomes are posted. */
export const META_RECAP_THREAD_ID = "recap_thread_id";
/** Current week's header message id — edited into the chronicle at finalize. */
export const META_RECAP_HEADER_ID = "recap_header_msg_id";
/** Date the current week began ('YYYY-MM-DD') — the digest window lower bound. */
export const META_RECAP_WEEK_START = "recap_week_start";
/** Incrementing "Week N" counter. */
export const META_RECAP_WEEK_NUMBER = "recap_week_number";
/** Monday-beat idempotency stamp (mirrors last_leaderboard_date). */
export const META_LAST_RECAP_DATE = "last_recap_date";

/** Discord hard cap on a message's content length. */
const MAX_MSG = 2000;

function clip(text: string): string {
  return text.length <= MAX_MSG ? text : `${text.slice(0, MAX_MSG - 1)}…`;
}

/**
 * The placeholder header posted at the start of a week, before its recap exists.
 * Players see this pinned with the live thread hanging off it; on the next Monday
 * it is edited in place into the finalized chronicle (see buildRecapHeader).
 */
export function buildPlaceholderHeader(weekNumber: number, startDate: string): string {
  return [
    `📜 **Week ${weekNumber}** — _the tale unfolds in the thread below._`,
    `Begun ${startDate}. This week's chronicle is written here next Monday.`,
  ].join("\n");
}

/**
 * The finalized header: the week's digest + highlights, edited over the
 * placeholder. Clipped to Discord's 2000-char message cap.
 */
export function buildRecapHeader(
  weekNumber: number,
  startDate: string,
  recap: RecapResult,
): string {
  const lines = [`📜 **Week ${weekNumber} — The Chronicle** _(begun ${startDate})_`, ""];
  lines.push(recap.digest || "_A quiet week at the Oak — nothing worth the telling._");
  if (recap.highlights.length > 0) {
    lines.push("");
    for (const h of recap.highlights) lines.push(`• ${h}`);
  }
  lines.push("");
  lines.push("_Full play-by-play in the thread below._");
  return clip(lines.join("\n"));
}

/**
 * Deterministic recap used when there's no LLM gateway or the call fails. Keeps
 * the Monday beat unblocked: a one-line count digest plus heuristic highlights
 * (the week's successes/failures, most recent first).
 */
function deterministicRecap(actions: WeeklyActionSummary[]): RecapResult {
  if (actions.length === 0) {
    return { digest: "A silent week — no souls stirred at the Oak.", highlights: [] };
  }
  const souls = new Set(actions.map((a) => a.character)).size;
  const digest = `${actions.length} action${actions.length === 1 ? "" : "s"} across ${souls} soul${souls === 1 ? "" : "s"} this week.`;
  const highlights = actions
    .filter((a) => a.outcome === "success" || a.outcome === "failure")
    .slice(-10)
    .reverse()
    .map((a) => `${a.character} — ${a.type} (${a.outcome})`);
  return { digest, highlights };
}

/**
 * Produce the week's recap. Uses the LLM gateway when present, falling back to a
 * deterministic summary on any failure (or no gateway / no actions) so the header
 * always finalizes.
 */
export async function generateWeeklyDigest(
  actions: WeeklyActionSummary[],
  gateway: RecapGateway | undefined,
): Promise<RecapResult> {
  if (gateway && actions.length > 0) {
    try {
      return await gateway.summarizeWeek(actions);
    } catch (err) {
      console.warn(
        c.yellow("[recap] LLM summary failed — using deterministic fallback:"),
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return deterministicRecap(actions);
}

// ── Outcome routing ──

/** The public-broadcast payload shape shared by thread sends and channel followUps. */
export interface OutcomePayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
}

type ChannelFetcher = { channels: { fetch: (id: string) => Promise<unknown> } };
type Sendable = { send: (opts: OutcomePayload) => Promise<unknown> };

function isSendable(channel: unknown): channel is Sendable {
  return (
    !!channel &&
    typeof (channel as { send?: unknown }).send === "function"
  );
}

/**
 * Post a public action outcome into the current week's recap thread. Falls back
 * to `fallback()` — the original channel followUp — when there is no thread id,
 * the thread can't be fetched, or it isn't sendable, so an outcome is never lost.
 */
export async function broadcastOutcome(opts: {
  client: ChannelFetcher;
  threadId: string | null | undefined;
  payload: OutcomePayload;
  fallback: () => Promise<unknown>;
}): Promise<void> {
  const { client, threadId, payload, fallback } = opts;
  if (threadId) {
    try {
      const channel = await client.channels.fetch(threadId);
      if (isSendable(channel)) {
        await channel.send(payload);
        return;
      }
    } catch (err) {
      console.warn(
        c.yellow("[recap] thread post failed — falling back to channel:"),
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  await fallback();
}
