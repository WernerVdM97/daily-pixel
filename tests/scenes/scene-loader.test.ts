import { describe, it, expect } from "vitest";
import { SceneLoader, SceneLoadError } from "../../src/scenes/SceneLoader.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "warden-scene-"));
}

function writeFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, "utf-8");
}

describe("SceneLoader", () => {
  it("loads all .ascii files from a directory", () => {
    const dir = tmpDir();
    writeFile(
      dir,
      "oak.ascii",
      `---
tags: [oak, interior, fire, sanctuary]
---
  ,@@@@@@,
 ,@@@@@@@@,
  @@  @@
`,
    );
    writeFile(
      dir,
      "road.ascii",
      `---
tags: [road, travel, open]
---
  ~  ~  ~
   ~  ~
`,
    );
    const loader = new SceneLoader(dir);
    const scenes = loader.loadAll();

    expect(scenes.size).toBe(2);
    expect(scenes.get("oak")!.tags).toEqual([
      "oak",
      "interior",
      "fire",
      "sanctuary",
    ]);
    expect(scenes.get("oak")!.body).toContain(",@@@@@@,");
    expect(scenes.get("road")!.tags).toEqual(["road", "travel", "open"]);
  });

  it("skips non-.ascii files", () => {
    const dir = tmpDir();
    writeFile(
      dir,
      "oak.ascii",
      `---
tags: [oak]
---
  tree
`,
    );
    writeFile(dir, "notes.txt", "not a scene file");
    const loader = new SceneLoader(dir);
    const scenes = loader.loadAll();
    expect(scenes.size).toBe(1);
  });

  it("throws SceneLoadError when directory is missing", () => {
    const loader = new SceneLoader("/nonexistent/dir");
    expect(() => loader.loadAll()).toThrow(SceneLoadError);
  });

  it("throws SceneLoadError for missing frontmatter", () => {
    const dir = tmpDir();
    writeFile(dir, "bad.ascii", "just ascii\nno frontmatter\n");
    const loader = new SceneLoader(dir);
    expect(() => loader.loadAll()).toThrow(SceneLoadError);
  });

  it("throws SceneLoadError for missing tags", () => {
    const dir = tmpDir();
    writeFile(
      dir,
      "notags.ascii",
      `---
description: no tags
---
some body
`,
    );
    const loader = new SceneLoader(dir);
    expect(() => loader.loadAll()).toThrow(SceneLoadError);
  });

  it("throws SceneLoadError when body line width exceeds 30 characters", () => {
    const dir = tmpDir();
    writeFile(
      dir,
      "wide.ascii",
      `---
tags: [wide]
---
short line
this line is definitely longer than thirty characters and should fail validation
`,
    );
    const loader = new SceneLoader(dir);
    expect(() => loader.loadAll()).toThrow(SceneLoadError);
    try {
      loader.loadAll();
    } catch (e) {
      expect(e).toBeInstanceOf(SceneLoadError);
      expect((e as SceneLoadError).message).toContain("exceeds 30");
    }
  });

  it("allows body lines exactly at 30 characters", () => {
    const dir = tmpDir();
    const line30 = "a".repeat(30);
    writeFile(
      dir,
      "exact.ascii",
      `---
tags: [exact]
---
${line30}
`,
    );
    const loader = new SceneLoader(dir);
    const scenes = loader.loadAll();
    expect(scenes.size).toBe(1);
    expect(scenes.get("exact")!.body).toBe(line30);
  });

  it("reports the failing filename in the error", () => {
    const dir = tmpDir();
    writeFile(
      dir,
      "bad.ascii",
      `---
tags: [bad]
---
this line is way too long for valid ASCII art and should definitely fail
`,
    );
    const loader = new SceneLoader(dir);
    try {
      loader.loadAll();
    } catch (e) {
      expect((e as SceneLoadError).message).toContain("bad.ascii");
    }
  });
});
