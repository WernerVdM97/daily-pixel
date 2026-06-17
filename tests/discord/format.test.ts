import { describe, it, expect } from "vitest";
import { buildComponentPayload, getNavButtons, SEPARATOR, IS_COMPONENTS_V2 } from "../../src/discord/format.js";

const CONTAINER = 17;
const TEXT_DISPLAY = 10;
const MEDIA_GALLERY = 12;
const SEPARATOR_CT = 14;

function container(payload: ReturnType<typeof buildComponentPayload>) {
  return payload.components.find(c => c.type === CONTAINER) as {
    type: number;
    components: Array<{ type: number; content?: string; items?: Array<{ media: { url: string } }> }>;
  };
}

describe("buildComponentPayload", () => {
  it("wraps plain text in a Components V2 container", () => {
    const payload = buildComponentPayload("hello world");
    expect(payload.flags).toBe(IS_COMPONENTS_V2);
    const inner = container(payload).components;
    expect(inner).toHaveLength(1);
    expect(inner[0]).toEqual({ type: TEXT_DISPLAY, content: "hello world" });
  });

  it("splits sections on the SEPARATOR with a separator component between", () => {
    const payload = buildComponentPayload(`top${"\n"}${SEPARATOR}${"\n"}bottom`);
    const types = container(payload).components.map(c => c.type);
    expect(types).toEqual([TEXT_DISPLAY, SEPARATOR_CT, TEXT_DISPLAY]);
  });

  it("prepends a MediaGallery referencing the attachment when an image is given", () => {
    const payload = buildComponentPayload("a new day", { image: "daily-pixel-banner.png" });
    const inner = container(payload).components;
    expect(inner[0]).toEqual({
      type: MEDIA_GALLERY,
      items: [{ media: { url: "attachment://daily-pixel-banner.png" } }],
    });
    // Text still follows the image.
    expect(inner.some(c => c.type === TEXT_DISPLAY && c.content === "a new day")).toBe(true);
  });

  it("omits the MediaGallery when no image is given", () => {
    const inner = container(buildComponentPayload("plain")).components;
    expect(inner.some(c => c.type === MEDIA_GALLERY)).toBe(false);
  });

  it("appends nav button rows after the container", () => {
    const nav = getNavButtons({ rollsRemaining: 0, lastActionState: null }, "hi");
    const payload = buildComponentPayload("text", { navButtons: nav });
    // The container is first; nav action rows follow.
    expect(payload.components[0].type).toBe(CONTAINER);
    expect(payload.components.length).toBeGreaterThan(1);
  });

  it("folds the ephemeral option into the flags bitfield (no deprecated `ephemeral` field)", () => {
    const EPHEMERAL = 1 << 6;
    const payload = buildComponentPayload("hi", { ephemeral: true });
    expect("ephemeral" in payload).toBe(false);
    expect(payload.flags & EPHEMERAL).toBe(EPHEMERAL);
    expect(payload.flags & IS_COMPONENTS_V2).toBe(IS_COMPONENTS_V2);
    // Non-ephemeral leaves the bit clear.
    expect(buildComponentPayload("hi").flags & EPHEMERAL).toBe(0);
  });
});

// Helper: collect the nav button ids a context produces.
function navIds(char: { rollsRemaining: number; lastActionState: unknown }, current?: string): string[] {
  return getNavButtons(char, current).flatMap(row =>
    row.components.map(b => b.custom_id.replace(/^nav:/, "")),
  );
}

describe("getNavButtons — action/sleep are mutually exclusive", () => {
  it("shows Action (not Sleep) while rolls remain", () => {
    const ids = navIds({ rollsRemaining: 2, lastActionState: null });
    expect(ids).toContain("action");
    expect(ids).not.toContain("sleep");
  });

  it("shows Sleep (not Action) when out of rolls and idle", () => {
    const ids = navIds({ rollsRemaining: 0, lastActionState: null });
    expect(ids).toContain("sleep");
    expect(ids).not.toContain("action");
  });

  it("shows Action (not Sleep) when out of rolls but mid-action — so you can resume", () => {
    const ids = navIds({ rollsRemaining: 0, lastActionState: { foo: 1 } });
    expect(ids).toContain("action");
    expect(ids).not.toContain("sleep");
  });
});
