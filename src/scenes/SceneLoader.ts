import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { loadAsciiFile, AsciiLoadError } from "../assets/ascii-loader.js";

export class SceneLoadError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly cause?: unknown,
  ) {
    super(`Scene load error in ${filePath}: ${message}`);
    this.name = "SceneLoadError";
  }
}

export interface SceneFile {
  tags: string[];
  body: string;
}

/**
 * Loads and validates all .ascii scene files from a directory.
 * Fail-fast: throws SceneLoadError on first invalid file.
 */
export class SceneLoader {
  constructor(private readonly directory: string) {}

  loadAll(): Map<string, SceneFile> {
    const scenes = new Map<string, SceneFile>();

    let entries: string[];
    try {
      entries = readdirSync(this.directory);
    } catch (e) {
      throw new SceneLoadError(
        "Directory not found or unreadable",
        this.directory,
        e,
      );
    }

    for (const entry of entries) {
      if (extname(entry) !== ".ascii") continue;

      const filePath = join(this.directory, entry);
      const name = entry.slice(0, -6); // strip ".ascii"

      try {
        const ascii = loadAsciiFile(filePath);
        this.validateBody(ascii.body, filePath);
        scenes.set(name, { tags: ascii.tags, body: ascii.body });
      } catch (e) {
        if (e instanceof AsciiLoadError) {
          throw new SceneLoadError(e.message, filePath, e);
        }
        throw e;
      }
    }

    return scenes;
  }

  private validateBody(body: string, filePath: string): void {
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 30) {
        throw new SceneLoadError(
          `Line ${i + 1} exceeds 30 characters (${lines[i].length})`,
          filePath,
        );
      }
    }
  }
}
