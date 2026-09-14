/**
 * The recording/replay clock pin (DC-M10.6). Used by BOTH halves: a deterministic recorder
 * pins the clock it stamps into the protocol-log header, and replay pins itself to that same
 * stamp. Pinning only the replay half is not enough — the recording would still read the wall
 * clock, so the two would disagree on any weekday branch, which is the SF3 caveat that
 * deferred real-backend corpus entries from M8.5 all the way to here. What the pin delivers is
 * spelled out on `pinClock` below: the UTC-based reads everywhere, and the local-weekday greeting
 * only on hosts that share a timezone.
 *
 * The ADVANCING pin (spec § G "the time axis", contract §10) extends the same doctrine to a
 * multi-day run: the harness's nightly tick moves the process clock one calendar day, so a
 * fast multi-day run crosses weekdays/weeks like a real one. Without it the Saturday bonus
 * roll, the weekend greeting and the five-day absence nudge all read whatever weekday the
 * suite happens to run on, and the interruption the panel exists to measure never fires.
 */

const DAY_MS = 86_400_000;

/**
 * Substitute a `Date` whose no-argument reads return `base + offsetMs()`, and return the
 * unconditional restore. The subclass covers both `new Date()` and `Date.now()` — the only two
 * forms the affected sites use — and leaves everything else alone: statics like `Date.parse`,
 * explicit-argument `new Date(x)`, timers and intervals all behave exactly as they did. That
 * is what makes the restore unconditional rather than best-effort.
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
  // runtime; TypeScript cannot verify that a subclass satisfies the whole `DateConstructor` surface,
  // which is the only thing this assertion claims. The restore closure puts the real one back.
  globalThis.Date = PinnedDate as unknown as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

/**
 * Pin the process clock to the header's `recordedAt` for the duration of a replay (DC-M10.6),
 * returning the restore function. This is what discharges SF3 for the reads that agree on a form:
 * the tick's `getUTCDay() === 6` (WorldEngineImpl.ts) and the greeting's `isWeekend()`
 * (hiScreen.ts) both used to come straight off the wall clock, so a Thursday recording diverged when
 * replayed on a Saturday and real-backend corpus entries had to be deferred for it. Pinning the
 * instant fixes every UTC-based read, because the same instant has the same UTC weekday everywhere.
 * It does NOT fix a read that goes through the LOCAL weekday: `isWeekend()` is `new Date().getDay()`,
 * so a recording and a replay agree on the greeting only when both run in the same timezone. See
 * `docs/engine/agent-player-personas.md` (the world-clock bullet) and the noon-UTC start rule in
 * `.pi/skills/agent-smoke/SKILL.md`.
 *
 * Swapping the global rather than threading a clock dependency through the engine and
 * controller is deliberate: replay is a test instrument, the alternative is a new constructor
 * argument on production code that only replay would ever pass, and the subclass covers both
 * `new Date()` and `Date.now()` — the only two forms the affected sites use. It is NOT a
 * general fake-timer: timers, intervals and explicitly-argumented `new Date(x)` are all
 * untouched, which is why the restore below is unconditional rather than best-effort.
 *
 * Single-instant, so it is the right pin for a one-day stream. A multi-day recording needs
 * `pinAdvancingClock` — see below and `replay.ts`'s per-tick advance.
 */
export function pinClock(iso: string): () => void {
  return pinFixedClock(iso, () => 0);
}

/** The handle `pinAdvancingClock` returns: the unconditional restore plus the day-stepper. */
export interface AdvancingClock {
  /** Restore the real `Date` — unconditional, like `pinClock`'s return. */
  restore(): void;
  /** Move the pinned clock forward `n` days (a no-op after `restore`). */
  advanceDays(n: number): void;
}

/**
 * Pin the process clock to `iso` and hand back the stepper a multi-day run drives (contract
 * §10, spec § G). `now()` returns `parse(iso) + daysAdvanced * 86_400_000` — a FIXED instant
 * plus whole days, deliberately NOT "real now plus an offset": the run must be deterministic,
 * and a real-time term would make every recorded envelope depend on how long the run took.
 *
 * Exactly as narrow as `pinClock` (same subclass, same two forms, same unconditional restore);
 * the ONLY difference is that the fixed instant is steppable. `iso` must be parseable — both
 * callers (`play.ts` validates `AGENT_START_DATE`, `replay.ts` validates the header stamp)
 * check before they pin, same as they always did for `pinClock`.
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
