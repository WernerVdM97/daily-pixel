import type { SceneFile } from "./SceneLoader.js";

/**
 * Deterministic tag-based scene resolver.
 *
 * For a given set of location tags, finds the scene whose tags have
 * the highest overlap count. On tie, returns the first scene encountered
 * (Map iteration order). On zero overlap, returns "unknown".
 */
export class TagResolver {
  constructor(private readonly scenes: Map<string, SceneFile>) {}

  resolve(locationTags: string[]): string {
    let bestName = "unknown";
    let bestScore = 0;

    for (const [name, scene] of this.scenes) {
      const score = intersectionSize(locationTags, scene.tags);
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }

    return bestName;
  }
}

function intersectionSize(a: string[], b: string[]): number {
  const set = new Set(b);
  let count = 0;
  for (const item of a) {
    if (set.has(item)) count++;
  }
  return count;
}
