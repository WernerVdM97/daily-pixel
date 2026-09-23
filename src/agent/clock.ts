/**
 * The recording/replay clock pin, used by BOTH halves: a recorder pins the clock it stamps into the
 * protocol-log header and replay pins to that stamp, or the two disagree on any weekday branch.
 */

const DAY_MS = 86_400_000;

/**
 * Substitute a `Date` whose no-argument reads return `base + offsetMs()`, and return the unconditional
 * restore. Not a general fake-timer: `Date.parse`, explicit-argument dates and timers are untouched.
 */
function pinFixedClock(iso: string, offsetMs: () => number): () => void {
  const RealDate = globalThis.Date;
  const base = new RealDate(iso).getTime();
  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(base + offsetMs());
      else super(...(args as [number]));
    }
    static override now(): number {
      return base + offsetMs();
    }
  }
  // SAFETY: `PinnedDate` extends the real `Date`, so it carries every static and instance member at
  // runtime; the assertion claims only what TypeScript cannot verify. The restore puts the real one back.
  globalThis.Date = PinnedDate as unknown as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

/**
 * Pin the process clock to the header's `recordedAt` for the duration of a replay, returning the
 * restore. Fixes every UTC read; not `isWeekend()`'s local weekday, so both ends need one timezone.
 */
export function pinClock(iso: string): () => void {
  return pinFixedClock(iso, () => 0);
}

/** The handle `pinAdvancingClock` returns: the unconditional restore plus the day-stepper. */
export interface AdvancingClock {
  /** Restore the real `Date` — unconditional, like `pinClock`'s return. */
  restore(): void;
  /** Move the pinned clock forward `n` days (a no-op after `restore`). Without the step every day of a
   *  multi-day run reads `iso`'s weekday, so the Saturday bonus and the absence nudge never fire. */
  advanceDays(n: number): void;
}

/**
 * Pin the process clock to `iso` and hand back the stepper a multi-day run drives. `now()` is the fixed
 * instant plus whole days, deliberately not real-now-plus-offset; `iso` must be parseable.
 */
export function pinAdvancingClock(iso: string): AdvancingClock {
  let daysAdvanced = 0;
  const restore = pinFixedClock(iso, () => daysAdvanced * DAY_MS);
  return {
    advanceDays(n: number): void {
      daysAdvanced += n;
    },
    restore,
  };
}
