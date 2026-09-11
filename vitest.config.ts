import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Seed the emoji registry (mirrors boot) before every test file.
    setupFiles: ['./tests/setup.ts'],
    // Keep CI output readable: suppress the console output of PASSING tests
    // (e.g. `[migrate] applied …`, intentional `[llm:error]`/`[sleep] tick
    // failed` error-path logs). Logs for a FAILING test are still shown, so
    // real failures stay easy to diagnose.
    silent: 'passed-only',
  },
});
