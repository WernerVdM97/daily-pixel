# Render Engine — Size Estimates

Server-side PNG and MP4 generation for Discord delivery. Numbers from a real Pillow-based test (2026-06-12).

---

## PNG — pixel-art style (16-color palette, chunky blocks)

| Scene (char grid) | Pixel resolution | File size | Base64 |
|---|---|---|---|
| 30×16 @ 4x | 120×64 | 1,425 B | ~2,000 B |
| 30×16 @ 6x | 180×96 | 1,519 B | ~2,125 B |
| 60×32 @ 3x | 180×96 | 2,674 B | ~3,665 B |
| 60×32 @ 4x | 240×128 | 2,816 B | ~3,854 B |
| 80×50 @ 3x | 240×150 | 4,399 B | ~5,965 B |
| 120×80 @ 2x | 240×160 | 8,186 B | ~11,014 B |

PNG compression is extremely efficient on limited-palette, block-structured pixel art.

## PNG — rich scene (256 colors, gradients, noise)

| Pixel resolution | File size | Base64 |
|---|---|---|
| 180×96 | 33,822 B | ~45,196 B |
| 240×160 | 73,165 B | ~97,653 B |
| 360×192 | 127,136 B | ~169,614 B |
| 480×320 | 271,719 B | ~362,392 B |
| 600×400 | 419,393 B | ~559,290 B |

Rich scenes compress worse due to gradients and noise (fewer long runs of identical pixels).

## MP4 — H.264 @ 15fps, CRF 28 (Discord inline-playable)

| Scenario | Resolution | Frames | Estimated size |
|---|---|---|---|
| 3s, campfire flicker | 180×96 | 45 | ~14 KB |
| 5s, scene transition | 240×160 | 75 | ~40 KB |
| 5s, combat sequence | 360×192 | 75 | ~66 KB |
| 8s, longer event | 360×192 | 120 | ~101 KB |
| 5s, high-res event | 480×320 | 75 | ~138 KB |

Discord auto-plays short MP4s inline on desktop and mobile.

## Discord limits

| Tier | Upload limit |
|---|---|
| Free | 8 MB |
| Nitro Basic | 25 MB |
| Nitro | 500 MB |

All estimates above fit comfortably within the free tier — the largest scenario is ~5% of the 8 MB limit.

---

*Estimate reference, not a specification. Hand-off to spec-driven-development for the render pipeline contract.*
