import type { WorldEngineImpl } from '../engine/WorldEngineImpl.js';

/**
 * Advance the game clock by `n` days via the engine's own daily tick
 * (WorldEngineImpl.ts:1543) — refills rolls_remaining to the daily allowance, regens
 * stamina/health in safe locations (drains it in unsafe ones), and pays day-job income.
 * A week = 7 calls.
 *
 * [!] Always ticks admin-style (`tick(true)`), bypassing cron idempotency. A non-admin
 * tick (`tick(false)`) no-ops once `meta.last_cron_date` already matches today's REAL
 * calendar date (WorldEngineImpl.ts:1551-1563) — driving N ticks in one process on the
 * same wall-clock day would silently no-op every tick after the first.
 *
 * [!] Real-clock leak (documented, not fought): the Saturday bonus-roll and 5-day-absence
 * nudge read `new Date()`. Pin it with `vi.useFakeTimers()` + `vi.setSystemTime(...)` in
 * tests (as happy-path.test.ts:131-132 does); from the standalone CLI it tracks the real
 * weekday — a minor, documented variance (a +1 roll on Saturdays), not a blocker.
 */
export function advanceDays(engine: WorldEngineImpl, n: number): void {
  for (let i = 0; i < n; i++) {
    engine.tick(true);
  }
}

export function currentDayNumber(engine: WorldEngineImpl): number {
  return Number(engine.getMeta('day_number') ?? '1');
}
