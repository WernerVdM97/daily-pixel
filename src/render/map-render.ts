import type { DiscoveredGraph, DiscoveredNode } from "../engine/WorldEngine.js";
import { SEPARATOR, directionArrow, directionRank, oppositeDirection } from "./format.js";

/** Effort glyph from an incoming edge's difficulty band (§5). */
const EFFORT = ["", "🚶", "🏃", "🧗"] as const;
const HOME_REGION = "The Vale";
/** Per-region node cap before the tail collapses into a "+K more" line. */
const REGION_CAP = 12;
/** Discord hard cap is ~2000; stay clear so the wrapper/codeblock never overflows. */
const CHAR_BUDGET = 1900;

function effortGlyph(difficulty: number | undefined): string {
  return difficulty && difficulty >= 1 && difficulty <= 3 ? EFFORT[difficulty] : "";
}

// ── Fuzzy focus matching (/map <region|place>) ──

/** Where a `/map <arg>` resolved to: a region to drill into, a place to zoom to, or nothing. */
export type MapFocus =
  | { kind: "region"; name: string }
  | { kind: "node"; name: string }
  | { kind: "none" };

/** Edit distance — small inputs (place/region names), so the simple two-row DP is plenty. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Below this, a candidate isn't considered a match (keeps "atlantis" from matching anything). */
const MATCH_FLOOR = 30;

/**
 * Forgiving match of a query against one candidate name. Tiered so an exact/prefix hit always
 * beats a fuzzy one: exact 100 · whole-string prefix 90 · any-word prefix 80 · substring 70 ·
 * all multi-word tokens present 65 · else a Levenshtein-similarity score (≤50) against the whole
 * string or any single word, floored at 0.6 similarity. So `town`→`Town Square` (90), `vale`→
 * `The Vale` (80 word-prefix), and the typo `twn`→`Town Square` (~38) all land; noise scores 0.
 */
function matchScore(query: string, candidate: string): number {
  const c = candidate.trim().toLowerCase();
  if (!c) return 0;
  if (c === query) return 100;
  if (c.startsWith(query)) return 90;
  const words = c.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(query))) return 80;
  if (c.includes(query)) return 70;
  const qWords = query.split(/[^a-z0-9]+/).filter(Boolean);
  if (qWords.length > 1 && qWords.every((qw) => c.includes(qw))) return 65;
  const sim = Math.max(
    0,
    ...[c, ...words].map((s) => 1 - levenshtein(query, s) / Math.max(query.length, s.length)),
  );
  return sim >= 0.6 ? Math.round(50 * sim) : 0;
}

/**
 * Resolve a `/map <arg>` against the discovered graph's region labels and place names. Returns the
 * single best match (ties: region before node, then shorter/alphabetical name — deterministic), or
 * `{ kind: "none" }` when nothing clears the floor.
 */
export function resolveMapFocus(query: string, graph: DiscoveredGraph): MapFocus {
  const q = query.trim().toLowerCase();
  if (!q) return { kind: "none" };

  // Use effective regions (same BFS-parent fallback as renderMap) so the candidate list
  // matches what the renderer actually groups — a null-region node won't contribute a
  // spurious "Elsewhere" that resolves to an empty drill-in.
  const rTree = buildTree(graph);
  const rByName = new Map(graph.nodes.map((n) => [n.name, n]));
  const regions = [...new Set(graph.nodes.map((n) => effectiveRegion(n.name, rByName, rTree)))];
  const candidates: Array<{ kind: "region" | "node"; name: string }> = [
    ...regions.map((name) => ({ kind: "region" as const, name })),
    ...graph.nodes.map((n) => ({ kind: "node" as const, name: n.name })),
  ];

  const best = candidates
    .map((cand) => ({ ...cand, score: matchScore(q, cand.name) }))
    .filter((cand) => cand.score >= MATCH_FLOOR)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.kind === b.kind ? 0 : a.kind === "region" ? -1 : 1) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name),
    )[0];

  return best ? { kind: best.kind, name: best.name } : { kind: "none" };
}

/**
 * Zoom to one place: the node, the charted roads that touch it (both edge directions — the heading
 * is reversed when the focused node sits on an edge's `to` side, since edges store one canonical
 * direction), and its own uncharted frontier exits. Headings sort clockwise from north.
 */
function renderNodeFocus(
  header: string,
  graph: DiscoveredGraph,
  byName: Map<string, DiscoveredNode>,
  focusName: string,
): string {
  const node = byName.get(focusName)!;
  const out = [header, SEPARATOR];
  const here = focusName === graph.current ? "  ◀ you are here" : "";
  out.push(`${node.emoji ?? "📍"}${node.isSafe ? "🛡️" : "⚠️"} **${node.name}** · ${node.region ?? "Elsewhere"}${here}`);

  const roads: Array<{ dir: string; difficulty: number; name: string }> = [];
  for (const e of graph.edges) {
    if (e.from === focusName) roads.push({ dir: e.direction, difficulty: e.difficulty, name: e.to });
    else if (e.to === focusName) roads.push({ dir: oppositeDirection(e.direction), difficulty: e.difficulty, name: e.from });
  }
  roads.sort((a, b) => directionRank(a.dir) - directionRank(b.dir));
  roads.forEach((r, i) => {
    const connector = i === roads.length - 1 ? "└─ " : "├─ ";
    // Full-map node parity: the destination's own place emoji + safety glyph, not just its name.
    const dest = byName.get(r.name);
    const destGlyph = dest ? `${dest.emoji ?? "📍"}${dest.isSafe ? "🛡️" : "⚠️"} ` : "";
    out.push(`${connector}${effortGlyph(r.difficulty)} ${directionArrow(r.dir)} ${destGlyph}${r.name}`.replace(/ {2,}/g, " ").trimEnd());
  });

  const frontiers = graph.frontiers
    .filter((f) => f.from === focusName)
    .sort((a, b) => directionRank(a.direction) - directionRank(b.direction));
  if (frontiers.length > 0) {
    out.push(SEPARATOR);
    out.push("**Unexplored paths**");
    frontiers.forEach((f, i) => {
      const connector = i === frontiers.length - 1 ? "└─ " : "├─ ";
      const teaser = f.teaser ? ` ${f.teaser}` : "";
      out.push(`${connector}${effortGlyph(f.difficulty)} ${directionArrow(f.direction)}${teaser}`.replace(/ {2,}/g, " ").trimEnd());
    });
  }

  if (roads.length === 0 && frontiers.length === 0) {
    out.push("_No charted roads lead from here yet._");
  }
  return out.join("\n");
}

interface TreeInfo {
  parent: Map<string, string>;
  depth: Map<string, number>;
  incomingDifficulty: Map<string, number>;
  childrenOf: Map<string, string[]>;
}

/**
 * BFS the discovered subgraph from the lowest-tier node (the Oak, tier 0) to assign
 * each node a parent, depth, and the difficulty of the edge it was reached by — the
 * hub-and-spoke tree the render walks. Disconnected nodes become their own roots.
 */
function buildTree(graph: DiscoveredGraph): TreeInfo {
  const byName = new Map(graph.nodes.map((n) => [n.name, n]));
  const adj = new Map<string, { to: string; difficulty: number }[]>();
  const add = (a: string, b: string, d: number) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push({ to: b, difficulty: d });
  };
  for (const e of graph.edges) {
    add(e.from, e.to, e.difficulty);
    add(e.to, e.from, e.difficulty); // adjacency is symmetric (you can walk back)
  }

  const parent = new Map<string, string>();
  const depth = new Map<string, number>();
  const incomingDifficulty = new Map<string, number>();

  // Roots: lowest node_tier first (the Oak), then by name — deterministic.
  const roots = [...graph.nodes].sort((a, b) => a.nodeTier - b.nodeTier || a.name.localeCompare(b.name));
  const queue: string[] = [];
  for (const r of roots) {
    if (depth.has(r.name)) continue;
    depth.set(r.name, 0);
    queue.push(r.name);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const { to, difficulty } of adj.get(cur) ?? []) {
        if (depth.has(to) || !byName.has(to)) continue;
        parent.set(to, cur);
        depth.set(to, depth.get(cur)! + 1);
        incomingDifficulty.set(to, difficulty);
        queue.push(to);
      }
    }
  }

  const childrenOf = new Map<string, string[]>();
  for (const [child, par] of parent) {
    if (!childrenOf.has(par)) childrenOf.set(par, []);
    childrenOf.get(par)!.push(child);
  }
  return { parent, depth, incomingDifficulty, childrenOf };
}

function regionOrder(regions: string[], currentRegion: string | null): string[] {
  const rest = regions.filter((r) => r !== HOME_REGION && r !== currentRegion).sort();
  const head = [HOME_REGION, currentRegion].filter((r): r is string => !!r && regions.includes(r));
  return [...new Set([...head, ...rest])];
}

/** Effective region for a node: its own region if set, else the nearest BFS ancestor's region,
 *  then "Elsewhere" if nothing in the chain has one. Handles legacy/unenriched null-region nodes
 *  so they group with their geographic neighbours rather than orphaning to a catch-all bucket. */
function effectiveRegion(name: string, byName: Map<string, DiscoveredNode>, tree: TreeInfo): string {
  let cur: string | undefined = name;
  while (cur !== undefined) {
    const region = byName.get(cur)?.region;
    if (region) return region;
    cur = tree.parent.get(cur);
  }
  return 'Elsewhere';
}

/** The emoji run for a node line: place · safe/wild · effort (effort omitted at a root). */
function nodeGlyphs(node: DiscoveredNode, tree: TreeInfo, isRoot: boolean): string {
  const safe = node.isSafe ? "🛡️" : "⚠️";
  const effort = isRoot ? "" : effortGlyph(tree.incomingDifficulty.get(node.name));
  return [node.emoji ?? "📍", safe, effort].filter(Boolean).join("");
}

/** The continuation prefix beneath a node, given the connector that drew it.
 *  `├─ ` siblings keep a `│  ` rail; `└─ ` (last) and roots go blank. */
function continuation(connector: string): string {
  if (connector === "├─ ") return "│  ";
  if (connector === "└─ ") return "   ";
  return ""; // root
}

/**
 * Render a player's discovered subgraph as an indented hub-and-spoke tree grouped by region,
 * with frontier exits as the hook (§5). Deterministic; siblings render most-recently-visited
 * first; an over-cap region tail collapses into "+K more" on the full map; the whole thing
 * stays under Discord's char cap — never a silent truncation. An optional `focus` fuzzily
 * resolves to a region (drill in, uncapped) or a place (zoom to that node's own roads).
 */
export function renderMap(characterName: string, graph: DiscoveredGraph, focus?: string): string {
  const tree = buildTree(graph);
  const byName = new Map(graph.nodes.map((n) => [n.name, n]));
  const charted = graph.nodes.length;
  const roads = graph.frontiers.length;

  const out: string[] = [];
  out.push(`🗺️ **${characterName}'s Map** — ${charted} charted · ${roads} ${roads === 1 ? "road" : "roads"} into the unknown`);

  // Resolve an optional focus fuzzily — it may name a region OR a place (typos/casing
  // tolerated; see resolveMapFocus). A place focus zooms to that node's own roads; a
  // region focus drills into the region (uncapped — the user asked for it).
  const focusRes = focus?.trim() ? resolveMapFocus(focus, graph) : undefined;
  if (focusRes?.kind === "none") {
    // Wrap the user's raw query in an inline-code span so markdown in it (e.g. `/map **x**`)
    // renders literally instead of formatting the error line.
    const shown = focus?.trim().replace(/`/g, "ʼ") ?? "";
    return `${out[0]}\n\n*No charted region or place matches \`${shown}\`.*`;
  }
  if (focusRes?.kind === "node") {
    return renderNodeFocus(out[0], graph, byName, focusRes.name);
  }
  const focusedRegion = focusRes?.kind === "region" ? focusRes.name : undefined;

  const currentRegion = byName.get(graph.current)?.region ?? null;

  // Group discovered nodes by region. A node with region = null inherits its nearest
  // BFS ancestor's region so it doesn't orphan to "Elsewhere" (decision: edge-bearing-inversion-and-region-reconciliation).
  const byRegion = new Map<string, DiscoveredNode[]>();
  for (const n of graph.nodes) {
    const r = effectiveRegion(n.name, byName, tree);
    if (!byRegion.has(r)) byRegion.set(r, []);
    byRegion.get(r)!.push(n);
  }

  const regions = focusedRegion
    ? [focusedRegion]
    : regionOrder([...byRegion.keys()], currentRegion);

  const recency = (a: DiscoveredNode, b: DiscoveredNode) =>
    (b.lastVisitedAt ?? "").localeCompare(a.lastVisitedAt ?? "") || a.name.localeCompare(b.name);

  for (const region of regions) {
    const nodes = byRegion.get(region) ?? [];
    // Discord separator between sections (buildComponentPayload turns the SEPARATOR
    // line into a real divider component); then a bold region label.
    out.push(SEPARATOR);
    out.push(`**${region}**${region === HOME_REGION ? " (home)" : ""}`);

    // Render as a tree with box-drawing connectors (├─ │ └─) so levels read on
    // mobile: region roots first, DFS, siblings by recency.
    const inRegion = new Set(nodes.map((n) => n.name));
    const rendered = new Set<string>();
    const renderSubtree = (name: string, prefix: string, connector: string, isRoot: boolean, lines: string[]) => {
      const node = byName.get(name);
      if (!node || rendered.has(name)) return;
      rendered.add(name);
      const marker = name === graph.current ? "  ◀ you are here" : "";
      lines.push(`${prefix}${connector}${nodeGlyphs(node, tree, isRoot)} ${node.name}${marker}`);
      const childPrefix = prefix + continuation(connector);
      const kids = (tree.childrenOf.get(name) ?? [])
        .filter((c) => inRegion.has(c))
        .map((c) => byName.get(c)!)
        .sort(recency);
      kids.forEach((kid, i) => {
        const last = i === kids.length - 1;
        renderSubtree(kid.name, childPrefix, last ? "└─ " : "├─ ", false, lines);
      });
    };

    const regionLines: string[] = [];
    const roots = nodes
      .filter((n) => !tree.parent.has(n.name) || !inRegion.has(tree.parent.get(n.name)!))
      .sort((a, b) => (tree.depth.get(a.name) ?? 0) - (tree.depth.get(b.name) ?? 0) || recency(a, b));
    for (const root of roots) renderSubtree(root.name, "", "", true, regionLines);
    // Any node not reached from a region root (odd disconnections) — append by recency.
    for (const n of [...nodes].sort(recency)) if (!rendered.has(n.name)) renderSubtree(n.name, "", "", true, regionLines);

    // Collapse an over-cap tail only on the full map — the drill target (/map <region>)
    // then shows the region uncapped, so it's a real next step, not a self-loop (Finding 3).
    if (!focusedRegion && regionLines.length > REGION_CAP) {
      const shown = regionLines.slice(0, REGION_CAP);
      const hidden = regionLines.length - REGION_CAP;
      shown.push(`└─ … +${hidden} more (/map ${region})`);
      out.push(...shown);
    } else {
      out.push(...regionLines);
    }
  }

  // Unexplored paths — the invitation to explore, grouped by the place they leave
  // from (only when not drilled into a region).
  if (graph.frontiers.length > 0 && !focusedRegion) {
    out.push(SEPARATOR);
    out.push("**Unexplored paths**");
    const byFrom = new Map<string, typeof graph.frontiers>();
    for (const f of graph.frontiers) {
      if (!byFrom.has(f.from)) byFrom.set(f.from, []);
      byFrom.get(f.from)!.push(f);
    }
    for (const [from, paths] of byFrom) {
      const emoji = byName.get(from)?.emoji ?? "📍";
      out.push(`${emoji} ${from}`);
      const ordered = [...paths].sort((a, b) => directionRank(a.direction) - directionRank(b.direction));
      ordered.forEach((f, i) => {
        const connector = i === ordered.length - 1 ? "└─ " : "├─ ";
        // Difficulty leads, then the compass arrow (no letter), then the teaser.
        const teaser = f.teaser ? ` ${f.teaser}` : "";
        out.push(`${connector}${EFFORT[f.difficulty] ?? ""} ${directionArrow(f.direction)}${teaser}`);
      });
    }
  }

  let text = out.join("\n");
  if (text.length > CHAR_BUDGET) {
    // Don't silently truncate — keep the header + a clear drill-in instruction.
    text = text.slice(0, CHAR_BUDGET).replace(/\n[^\n]*$/, "");
    text += focusedRegion
      ? `\n\n*This region is large — use \`/map <place>\` to focus on a single place's roads.*`
      : `\n\n*Your map is large — use \`/map <region>\` to drill in (regions: ${regions.join(", ")}).*`;
  }
  return text;
}
