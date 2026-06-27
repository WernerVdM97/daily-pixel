import type { DiscoveredGraph, DiscoveredNode } from "../engine/WorldEngine.js";

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
 * Render a player's discovered subgraph as an indented hub-and-spoke tree grouped
 * by region, with frontier exits as the hook (§5). Deterministic; siblings render
 * most-recently-visited first; an over-cap region tail collapses into "+K more";
 * the whole thing stays under Discord's char cap (drill in with /map <region> when
 * focus is omitted and it would overflow) — never a silent truncation.
 */
export function renderMap(characterName: string, graph: DiscoveredGraph, focus?: string): string {
  const tree = buildTree(graph);
  const byName = new Map(graph.nodes.map((n) => [n.name, n]));
  const charted = graph.nodes.length;
  const roads = graph.frontiers.length;

  const out: string[] = [];
  out.push(`🗺️ **${characterName}'s Map** — ${charted} charted · ${roads} ${roads === 1 ? "road" : "roads"} into the unknown`);

  const currentRegion = byName.get(graph.current)?.region ?? null;
  const focusNorm = focus?.trim().toLowerCase();

  // Group discovered nodes by region.
  const byRegion = new Map<string, DiscoveredNode[]>();
  for (const n of graph.nodes) {
    const r = n.region ?? "Uncharted";
    if (!byRegion.has(r)) byRegion.set(r, []);
    byRegion.get(r)!.push(n);
  }

  let regions = regionOrder([...byRegion.keys()], currentRegion);
  if (focusNorm) {
    regions = regions.filter((r) => r.toLowerCase() === focusNorm);
    // Focus may name a hub rather than a region — fall back to that node's region.
    if (regions.length === 0) {
      const hub = graph.nodes.find((n) => n.name.toLowerCase() === focusNorm);
      if (hub?.region) regions = [hub.region];
    }
    if (regions.length === 0) return `${out[0]}\n\n*No charted region or place matches "${focus}".*`;
  }

  const recency = (a: DiscoveredNode, b: DiscoveredNode) =>
    (b.lastVisitedAt ?? "").localeCompare(a.lastVisitedAt ?? "") || a.name.localeCompare(b.name);

  for (const region of regions) {
    const nodes = byRegion.get(region) ?? [];
    const label = region.toUpperCase() + (region === HOME_REGION ? " (home)" : "");
    out.push("");
    out.push(`── ${label} ──`);

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

    if (regionLines.length > REGION_CAP) {
      const shown = regionLines.slice(0, REGION_CAP);
      const hidden = regionLines.length - REGION_CAP;
      shown.push(`└─ … +${hidden} more (/map ${region})`);
      out.push(...shown);
    } else {
      out.push(...regionLines);
    }
  }

  // Frontier exits — the invitation to explore (only when not drilled into a region,
  // or when the focus region owns them). Show direction + teaser.
  if (graph.frontiers.length > 0 && !focusNorm) {
    out.push("");
    out.push("── ROADS NOT YET WALKED ──");
    for (const f of graph.frontiers) {
      const teaser = f.teaser ? ` ${f.teaser}` : "";
      out.push(`🧭 ${f.direction}${teaser}   ??? (from ${f.from})`);
    }
  }

  let text = out.join("\n");
  if (!focusNorm && text.length > CHAR_BUDGET) {
    // Don't silently truncate — keep the header + a clear drill-in instruction.
    const regionsList = regions.join(", ");
    text = text.slice(0, CHAR_BUDGET).replace(/\n[^\n]*$/, "");
    text += `\n\n*Your map is large — use \`/map <region>\` to drill in (regions: ${regionsList}).*`;
  }
  return text;
}
