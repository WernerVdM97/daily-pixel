/**
 * The recording/replay clock pin (DC-M10.6). Used by BOTH halves: a deterministic recorder
 * pins the clock it stamps into the protocol-log header, and replay pins itself to that same
 * stamp. Pinning only the replay half is not enough — the recording would still read the wall
 * clock, so the two would disagree on any weekday branch, which is the SF3 caveat that
 * deferred real-backend corpus entries from M8.5 all the way to here.
 */

/**
 * Pin the process clock to the header's `recordedAt` for the duration of a replay (DC-M10.6),
 * returning the restore function. This is what discharges SF3: the greeting reads
 * `isWeekend()` (hiScreen.ts) and the tick reads `getUTCDay() === 6` (WorldEngineImpl.ts),
 * both straight off the wall clock, so a Thursday recording used to diverge when replayed on
 * a Saturday and real-backend corpus entries had to be deferred for it.
 *
 * Swapping the global rather than threading a clock dependency through the engine and
 * controller is deliberate: replay is a test instrument, the alternative is a new constructor
 * argument on production code that only replay would ever pass, and the subclass covers both
 * `new Date()` and `Date.now()` — the only two forms the affected sites use. It is NOT a
 * general fake-timer: timers, intervals and explicitly-argumented `new Date(x)` are all
 * untouched, which is why the restore below is unconditional rather than best-effort.
 */
export function pinClock(iso: string): () => void {
  const RealDate = globalThis.Date;
  const fixed = new RealDate(iso).getTime();
  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [number]));
    }
    static override now(): number {
      return fixed;
    }
  }
  globalThis.Date = PinnedDate as unknown as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}
