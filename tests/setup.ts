// Seed the name→emoji registry from the real YAML before any test runs, mirroring
// the bot's boot (src/index.ts). Surfaces like /stats, /hi and /action resolve their
// class/day-job glyph through this registry; without seeding they'd render the
// fallback and emoji assertions would fail.
import { beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadYamlFile } from "../src/assets/yaml-loader.js";
import { registerEmoji } from "../src/render/format.js";

beforeAll(() => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "char-creation");
  registerEmoji("class", loadYamlFile(path.join(dir, "classes.yml")) as Array<{ name: string; emoji?: string }>);
  registerEmoji("dayJob", loadYamlFile(path.join(dir, "day-jobs.yml")) as Array<{ name: string; emoji?: string }>);
});
