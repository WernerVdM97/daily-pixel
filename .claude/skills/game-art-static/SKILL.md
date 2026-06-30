---
name: game-art-static
description: Static game art principles. Use when choosing visual style, colour/palette, composing ASCII scenes, organizing assets, or improving readability of non-animated art (ASCII, sprites, key art).
allowed-tools: Read, Glob, Grep
---

# Game Art Principles

> Visual design thinking for games - style selection, asset pipelines, and art direction.

---

## 1. Art Style Selection

### Decision Tree

```
What feeling should the game evoke?
│
├── Nostalgic / Retro
│   ├── Limited palette? → Pixel Art
│   └── Hand-drawn feel? → Vector / Flash style
│
├── Realistic / Immersive
│   ├── High budget? → PBR 3D
│   └── Stylized realism? → Hand-painted textures
│
├── Approachable / Casual
│   ├── Clean shapes? → Flat / Minimalist
│   └── Soft feel? → Gradient / Soft shadows
│
└── Unique / Experimental
    └── Define custom style guide
```

### Style Comparison Matrix

| Style | Production Speed | Skill Floor | Scalability | Best For |
|-------|------------------|-------------|-------------|----------|
| **Pixel Art** | Medium | Medium | Hard to hire | Indie, retro |
| **Vector/Flat** | Fast | Low | Easy | Mobile, casual |
| **Hand-painted** | Slow | High | Medium | Fantasy, stylized |
| **PBR 3D** | Slow | High | AAA pipeline | Realistic games |
| **Low-poly** | Fast | Medium | Easy | Indie 3D |
| **Cel-shaded** | Medium | Medium | Medium | Anime, cartoon |

---

## 2. Asset Pipeline Decisions

### 2D Pipeline

| Phase | Tool Options | Output |
|-------|--------------|--------|
| **Concept** | Paper, Procreate, Photoshop | Reference sheet |
| **Creation** | Aseprite, Photoshop, Krita | Individual sprites |
| **Atlas** | TexturePacker, Aseprite | Spritesheet |
| **Integration** | Engine import | Game-ready assets |

---

## 3. Color Theory Decisions

### Palette Selection

| Goal | Strategy | Example |
|------|----------|---------|
| **Harmony** | Complementary or analogous | Nature games |
| **Contrast** | High saturation differences | Action games |
| **Mood** | Warm/cool temperature | Horror, cozy |
| **Readability** | Value contrast over hue | Gameplay clarity |

### Color Principles

- **Hierarchy:** Important elements should pop
- **Consistency:** Same object = same color family
- **Context:** Colors read differently on backgrounds
- **Accessibility:** Don't rely only on color

---

## 4. Resolution & Scale Decisions

### 2D Resolution by Platform

| Platform | Base Resolution | Sprite Scale |
|----------|-----------------|--------------|
| Mobile | 1080p | 64-128px characters |
| Desktop | 1080p-4K | 128-256px characters |
| Pixel art | 320x180 to 640x360 | 16-32px characters |

### Consistency Rule

Choose a base unit and stick to it:
- Pixel art: Work at 1x, scale up (never down)
- HD art: Define DPI, maintain ratio
- 3D: 1 unit = 1 meter (industry standard)

---

## 5. Asset Organization

### Naming Convention

```
[type]_[object]_[variant]_[state].[ext]

Examples:
spr_player_idle_01.png
tex_stone_wall_normal.png
mesh_tree_oak_lod2.fbx
```

### Folder Structure Principle

```
assets/
├── characters/
│   ├── player/
│   └── enemies/
├── environment/
│   ├── props/
│   └── tiles/
├── ui/
├── effects/
└── audio/
```

---

## 6. Scene Composition

Static scenes are *assembled*, not hand-drawn in one pass — composite them from reusable fragments stacked in layers. *(Folded from 2D sprite/tilemap composition.)*

### Layering (Z-order)

Draw back-to-front; later layers occlude earlier ones.

| Layer | Content |
|-------|---------|
| Background | Non-interactive scenery |
| Terrain | Ground / setting |
| Props | Objects, items |
| Foreground | Overlay — characters, UI, dice |

### Reusable Fragments

| Technique | Purpose |
|-----------|---------|
| **Fragment library (atlas)** | A small bank of recombinable pieces (e.g. 2–3-line character sprites, location templates), assembled per scene rather than authored whole |
| **Z-order** | Composite fragments into one image, foreground last |

### Viewport

- Fix a target width and compose within it (e.g. a narrow mobile column).
- One scene per view — switch scenes rather than scroll a large canvas.
- Clarity first: every glyph should communicate; composition is as much what you leave out.

---

## 7. Anti-Patterns

| Don't | Do |
|-------|-----|
| Mix art styles randomly | Define and follow style guide |
| Work at final resolution only | Create at source resolution |
| Ignore silhouette readability | Test at gameplay distance |
| Over-detail background | Focus detail on player area |
| Skip color testing | Test on target display |

---

> **Remember:** Art serves gameplay. If it doesn't help the player, it's decoration.
