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
 * [!] Real-clock leak: the Saturday bonus-roll and 5-day-absence nudge read `new Date()`.
 * From a bare CLI run the calendar tracks the real weekday — a +1 roll on Saturdays, and no
 * absence to nudge unless the process really spans five wall-clock days. In tests either pin it
 * (`vi.useFakeTimers()` + `vi.setSystemTime(...)`, as happy-path.test.ts:131-132 does) or use
 * the agent harness's advancing pin (`pinAdvancingClock`, `src/agent/clock.ts`), which moves
 * the calendar one day per nightly tick and is what makes a fast multi-day agent run see
 * Saturdays and five-day absences at all. So this is no longer "a minor, documented variance"
 * for the agent harness specifically: a panel run that did not pin would measure a world whose
 * clock never moves, which is exactly the gap spec § G's time axis closes.
 */
export function advanceDays(engine: WorldEngineImpl, n: number): void {
  for (let i = 0; i < n; i++) {
    engine.tick(true);
  }
}

export function currentDayNumber(engine: WorldEngineImpl): number {
  return Number(engine.getMeta('day_number') ?? '1');
}
