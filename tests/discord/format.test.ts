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
});
