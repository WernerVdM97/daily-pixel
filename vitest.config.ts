import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Never scan git worktrees (agent-isolation copies live under .claude/) —
    // they duplicate every test file and triple the reported count.
    exclude: [...configDefaults.exclude, '.claude/**'],
    // Seed the emoji registry (mirrors boot) before every test file.
    setupFiles: ['./tests/setup.ts'],
    // Keep CI output readable: suppress the console output of PASSING tests
    // (e.g. `[migrate] applied …`, intentional `[llm:error]`/`[sleep] tick
    // failed` error-path logs). Logs for a FAILING test are still shown, so
    // real failures stay easy to diagnose.
    silent: 'passed-only',
  },
});
