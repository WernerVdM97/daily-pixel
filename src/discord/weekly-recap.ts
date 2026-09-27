import type { RecapGateway, RecapResult } from "../llm/LlmGateway.js";
import type { WeeklyActionSummary } from "../engine/WorldEngine.js";
import { c } from "../util/colors.js";

// ── meta keys (freeform key-value store) ──
/** Current week's thread id — where action outcomes are posted. */
export const META_RECAP_THREAD_ID = "recap_thread_id";
/** Current week's header message id — edited into the chronicle at finalize. */
export const META_RECAP_HEADER_ID = "recap_header_msg_id";
/** When the current week began ('YYYY-MM-DD HH:MM:SS' UTC); the digest window's lower bound. */
export const META_RECAP_WEEK_START = "recap_week_start";
/** Incrementing "Week N" counter. */
export const META_RECAP_WEEK_NUMBER = "recap_week_number";
/** Monday-beat idempotency stamp (mirrors last_leaderboard_date). */
export const META_LAST_RECAP_DATE = "last_recap_date";

// ── thread liveness ──
/** Discord REST "Unknown Channel" — the only signal a stored thread is truly deleted. */
export const DISCORD_UNKNOWN_CHANNEL = 10003;

/**
 * True only when the fetch failed because the thread is gone (10003): the one case where recreating the
 * week is safe. Rate limits, 5xx, network and permission errors are transient and must keep the week.
 */
export function isThreadDeleted(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === DISCORD_UNKNOWN_CHANNEL;
}

/** Discord's per-message content cap. */
const MAX_MSG = 2000;

function clip(text: string): string {
  return text.length <= MAX_MSG ? text : `${text.slice(0, MAX_MSG - 1)}…`;
}

/**
 * Placeholder header posted at week start. Edited in place into the finalized
 * chronicle next Monday (see buildRecapHeader).
 */
export function buildPlaceholderHeader(weekNumber: number, startDate: string): string {
  return [
    `📜 **Week ${weekNumber}** — _the tale unfolds in the thread below._`,
    `Begun ${startDate}. This week's chronicle is written here next Monday.`,
  ].join("\n");
}

/** Finalized header (digest + highlights) edited over the placeholder; clipped to MAX_MSG. */
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
 * Deterministic fallback (no gateway / call failed) so the Monday beat never blocks:
 * a count digest plus the week's successes/failures, most recent first.
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

// ── prompt input cap ──
/** Safety valve, not a routine trim (~9 active players at ~22 actions/week is above realistic scale); only the LLM path is capped, so the digest still counts every action. */
export const MAX_RECAP_ACTIONS = 200;
/** Per-action narrative chars sent to the LLM (~60 tokens) — enough gist to judge significance. */
export const MAX_RECAP_NARRATIVE = 240;

/**
 * Bound the prompt input: always truncates narratives; past MAX_RECAP_ACTIONS keeps the notable beats
 * plus the most recent of the rest, in original oldest-first order.
 */
export function capRecapActions(actions: WeeklyActionSummary[]): WeeklyActionSummary[] {
  const trimmed = actions.map((a) =>
    a.narrative.length > MAX_RECAP_NARRATIVE
      ? { ...a, narrative: `${a.narrative.slice(0, MAX_RECAP_NARRATIVE - 1)}…` }
      : a,
  );
  if (trimmed.length <= MAX_RECAP_ACTIONS) return trimmed;

  const isNotable = (o: string) => o === "success" || o === "failure";
  const kept = new Set(trimmed.filter((a) => isNotable(a.outcome)).slice(-MAX_RECAP_ACTIONS));
  const budget = MAX_RECAP_ACTIONS - kept.size;
  if (budget > 0) {
    for (const a of trimmed.filter((a) => !isNotable(a.outcome)).slice(-budget)) kept.add(a);
  }
  return trimmed.filter((a) => kept.has(a));
}

/**
 * Produce the week's recap via the gateway, falling back to a deterministic summary on
 * any failure (or no gateway / no actions) so the header always finalizes.
 */
export async function generateWeeklyDigest(
  actions: WeeklyActionSummary[],
  gateway: RecapGateway | undefined,
): Promise<RecapResult> {
  if (gateway && actions.length > 0) {
    try {
      const capped = capRecapActions(actions);
      if (capped.length < actions.length) {
        console.log(c.cyan(`[recap] capped ${actions.length} → ${capped.length} actions for the LLM prompt.`));
      }
      return await gateway.summarizeWeek(capped);
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

/** Payload shape shared by thread sends and channel followUps. */
export interface OutcomePayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  allowedMentions?: { users: string[]; parse?: string[] };
}

type ChannelFetcher = { channels: { fetch: (id: string) => Promise<unknown> } };
type Sendable = { send: (opts: OutcomePayload) => Promise<unknown> };
type ThreadMemberAddable = { members: { add: (userId: string) => Promise<unknown> } };

function isSendable(channel: unknown): channel is Sendable {
  return (
    !!channel &&
    typeof (channel as { send?: unknown }).send === "function"
  );
}

function canAddThreadMembers(channel: unknown): channel is ThreadMemberAddable {
  const members = (channel as { members?: { add?: unknown } } | null)?.members;
  return !!members && typeof members.add === "function";
}

/**
 * Post an outcome into the week's recap thread, falling back to `fallback()` when no thread is usable.
 * `subscribeUserIds` are added BEFORE the post (a ping-suppressed mention does not subscribe them) and `members.add` is idempotent; a failed add must not block the post.
 */
export async function broadcastOutcome(opts: {
  client: ChannelFetcher;
  threadId: string | null | undefined;
  payload: OutcomePayload;
  fallback: () => Promise<unknown>;
  subscribeUserIds?: string[];
}): Promise<void> {
  const { client, threadId, payload, fallback, subscribeUserIds } = opts;
  if (threadId) {
    try {
      const channel = await client.channels.fetch(threadId);
      // [debug] confirm what we resolved + which branch we take.
      console.log(
        c.cyan(
          `[recap][debug] threadId=${threadId} sendable=${isSendable(channel)} ` +
            `canAddMembers=${canAddThreadMembers(channel)} subscribe=${JSON.stringify(subscribeUserIds ?? null)} ` +
            `ctor=${(channel as { constructor?: { name?: string } } | null)?.constructor?.name}`,
        ),
      );
      if (isSendable(channel)) {
        if (subscribeUserIds?.length && canAddThreadMembers(channel)) {
          for (const userId of subscribeUserIds) {
            try {
              const added = await channel.members.add(userId);
              console.log(c.green(`[recap][debug] members.add(${userId}) OK → ${String(added)}`));
            } catch (err) {
              const e = err as { code?: unknown; status?: unknown; message?: unknown };
              console.warn(
                c.yellow(
                  `[recap] could not subscribe player ${userId} to thread ` +
                    `(code=${String(e?.code)} status=${String(e?.status)}):`,
                ),
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }
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
