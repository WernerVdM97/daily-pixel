import { describe, it, expect, vi } from "vitest";
import {
  buildPlaceholderHeader,
  buildRecapHeader,
  generateWeeklyDigest,
  broadcastOutcome,
} from "../../src/discord/weekly-recap.js";
import type { RecapGateway, RecapResult } from "../../src/llm/LlmGateway.js";
import type { WeeklyActionSummary } from "../../src/engine/WorldEngine.js";

function action(overrides?: Partial<WeeklyActionSummary>): WeeklyActionSummary {
  return { character: "Aldric", type: "travel", outcome: "success", narrative: "Onward.", ...overrides };
}

describe("weekly-recap formatters", () => {
  it("placeholder header names the week and points at the thread", () => {
    const h = buildPlaceholderHeader(3, "2026-06-22");
    expect(h).toContain("Week 3");
    expect(h).toContain("2026-06-22");
    expect(h.toLowerCase()).toContain("thread");
  });

  it("recap header renders digest + bulleted highlights", () => {
    const h = buildRecapHeader(3, "2026-06-22", {
      digest: "The eastern road opened.",
      highlights: ["Bron slew the wraith", "Aldric claimed the road"],
    });
    expect(h).toContain("Week 3");
    expect(h).toContain("The eastern road opened.");
    expect(h).toContain("• Bron slew the wraith");
    expect(h).toContain("• Aldric claimed the road");
  });

  it("recap header falls back to a quiet-week line when the digest is empty", () => {
    const h = buildRecapHeader(1, "2026-06-22", { digest: "", highlights: [] });
    expect(h.toLowerCase()).toContain("quiet week");
  });

  it("clips an over-long header to Discord's 2000-char cap", () => {
    const h = buildRecapHeader(1, "2026-06-22", {
      digest: "x".repeat(5000),
      highlights: [],
    });
    expect(h.length).toBeLessThanOrEqual(2000);
  });
});

describe("generateWeeklyDigest", () => {
  it("uses the LLM gateway when present", async () => {
    const result: RecapResult = { digest: "A grim week.", highlights: ["Bron fell"] };
    const gateway: RecapGateway = { summarizeWeek: vi.fn().mockResolvedValue(result) };
    const out = await generateWeeklyDigest([action()], gateway);
    expect(out).toEqual(result);
    expect(gateway.summarizeWeek).toHaveBeenCalledOnce();
  });

  it("falls back to a deterministic summary when the gateway throws", async () => {
    const gateway: RecapGateway = { summarizeWeek: vi.fn().mockRejectedValue(new Error("boom")) };
    const out = await generateWeeklyDigest(
      [action({ character: "Aldric", outcome: "success" }), action({ character: "Bron", outcome: "failure" })],
      gateway,
    );
    expect(out.digest).toContain("2 actions");
    expect(out.digest).toContain("2 souls");
    expect(out.highlights.length).toBe(2);
  });

  it("returns a silent-week digest with no gateway and no actions", async () => {
    const out = await generateWeeklyDigest([], undefined);
    expect(out.digest.toLowerCase()).toContain("silent week");
    expect(out.highlights).toEqual([]);
  });

  it("does not call the gateway when there are no actions", async () => {
    const gateway: RecapGateway = { summarizeWeek: vi.fn() };
    await generateWeeklyDigest([], gateway);
    expect(gateway.summarizeWeek).not.toHaveBeenCalled();
  });
});

describe("broadcastOutcome", () => {
  const payload = { content: "outcome" };

  it("posts into the thread when a thread id resolves to a sendable channel", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = { channels: { fetch: vi.fn().mockResolvedValue({ send }) } };
    const fallback = vi.fn().mockResolvedValue(undefined);

    await broadcastOutcome({ client, threadId: "thread-1", payload, fallback });

    expect(client.channels.fetch).toHaveBeenCalledWith("thread-1");
    expect(send).toHaveBeenCalledWith(payload);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to the channel when there is no thread id", async () => {
    const client = { channels: { fetch: vi.fn() } };
    const fallback = vi.fn().mockResolvedValue(undefined);

    await broadcastOutcome({ client, threadId: null, payload, fallback });

    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back when the thread fetch throws (e.g. deleted thread)", async () => {
    const client = { channels: { fetch: vi.fn().mockRejectedValue(new Error("unknown channel")) } };
    const fallback = vi.fn().mockResolvedValue(undefined);

    await broadcastOutcome({ client, threadId: "gone", payload, fallback });

    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back when the fetched channel isn't sendable", async () => {
    const client = { channels: { fetch: vi.fn().mockResolvedValue({}) } };
    const fallback = vi.fn().mockResolvedValue(undefined);

    await broadcastOutcome({ client, threadId: "weird", payload, fallback });

    expect(fallback).toHaveBeenCalledOnce();
  });
});
