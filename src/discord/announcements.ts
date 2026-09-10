/**
 * Content + formatting for the twice-daily morning (05:30 UTC) and evening
 * (18:30 UTC "goodnight") announcements.
 *
 * Prose rotates through a small pool keyed deterministically on the day
 * number (NOT `Math.random`), so the same day always renders the same
 * flavour line everywhere it's built — the live cron post, a boot-time
 * catch-up, and the admin `/sleep` tick echo all agree.
 *
 * The data lines (Day N, souls-stirred/NPC-movement counts, the
 * unsafe-souls warning, the Saturday threat heads-up) are untouched by the
 * rotation — only the scene-setting flavour sentence varies.
 *
 * All functions here are pure (data + string building) so they can be unit
 * tested; index.ts and the admin `/sleep` tick both call these builders
 * instead of duplicating the prose.
 */

export interface MorningAnnouncementData {
  day: number;
  playersAffected: number;
  npcMovementCount: number;
  /** Pre-built threat heads-up line (`buildThreatHeadsUp`), inserted verbatim when present (Saturdays). */
  threatHeadsUp?: string;
}

export interface EveningAnnouncementData {
  day: number;
  /** Live count of souls still out beyond the safe paths as night falls. */
  soulsInUnsafe: number;
}

const MORNING_FLAVOUR: readonly string[] = [
  "The warden watches the horizon. The fire crackles, steady and low.",
  "The smoke on the eastern horizon has thickened. The warden hasn't spoken since yesterday.",
  "Dew silvers the yard, and somewhere a rooster is losing its patience.",
  "The Oak creaks awake around you, timbers settling into the business of another day.",
  "A thin mist clings to the low ground, but the sky above is clear and the day looks fair.",
];

const EVENING_FLAVOUR: readonly string[] = [
  "Stars are pricking through the dusk, one by one, patient as ever.",
  "A cold wind combs the treeline, and the lanterns along the wall gutter but hold.",
  "Somewhere out past the ditch, an owl asks its question and gets no answer.",
  "The last light drains from the west, and the Oak's old boughs settle into their watch.",
  "Woodsmoke and quiet settle over the yard together, the way they do every night.",
];

/** Deterministic pool pick keyed on the day number — same day always picks the same line. */
function pickFlavour(pool: readonly string[], day: number): string {
  const idx = ((day % pool.length) + pool.length) % pool.length;
  return pool[idx];
}

/** The dawn (05:30) "Day N begins" announcement body. */
export function buildMorningAnnouncement(data: MorningAnnouncementData): string {
  const lines: string[] = [
    `🌅 **Day ${data.day} begins.**`,
    "",
    pickFlavour(MORNING_FLAVOUR, data.day),
    "",
    "The Oak awaits. `/hi` to begin.",
  ];

  if (data.playersAffected > 0 || data.npcMovementCount > 0) {
    lines.push("");
    lines.push(
      `─ ${data.playersAffected} soul(s) stirred, ${data.npcMovementCount} NPC(s) on the move.`,
    );
  }

  if (data.threatHeadsUp) {
    lines.push("");
    lines.push(data.threatHeadsUp);
  }

  return lines.join("\n");
}

/** The dusk (18:30) "goodnight" announcement body. */
export function buildEveningAnnouncement(data: EveningAnnouncementData): string {
  const dataLine =
    data.soulsInUnsafe > 0
      ? "The fire burns low and the dark draws close. " +
        `**${data.soulsInUnsafe}** soul(s) are still out beyond the safe paths — ` +
        "the wilds are patient, and they are not kind."
      : "Every soul is home beneath the boughs tonight. The dark presses " +
        "against the firelight, but the Oak stands watch.";

  const closing =
    data.soulsInUnsafe > 0
      ? "Will they make it back? Rest, those who can."
      : "Rest. Dawn comes when the world wills it.";

  return [
    "🌙 **Night falls over the Oak.**",
    "",
    dataLine,
    "",
    pickFlavour(EVENING_FLAVOUR, data.day),
    "",
    closing,
  ].join("\n");
}

/**
 * True when the morning (05:30) slot is suppressed because the midday (12:00) beat
 * already owns the day: Sat (wilderness threat) and Wed/Sun (leaderboards). Must stay
 * in lockstep with `runAfternoonBeat`'s weekday checks in src/index.ts — that function's
 * comment cross-references this one so the two can't drift.
 */
export function isMorningSuppressedDay(now: Date): boolean {
  const weekday = now.getUTCDay(); // 0 = Sunday … 6 = Saturday
  return weekday === 0 || weekday === 3 || weekday === 6;
}

/**
 * Why the morning announcement should be skipped, in priority order:
 * already-posted → tick-incomplete → suppressed-weekday. Null = post normally.
 * The 0/3/6 weekday set must stay in lockstep with `isMorningSuppressedDay` (same set).
 */
export function morningSkipReason(input: {
  alreadyPosted: boolean;
  tickCompleted: boolean;
  weekday: number;
}): 'already-posted' | 'tick-incomplete' | 'suppressed-weekday' | null {
  if (input.alreadyPosted) return 'already-posted';
  if (!input.tickCompleted) return 'tick-incomplete';
  if (input.weekday === 0 || input.weekday === 3 || input.weekday === 6) {
    return 'suppressed-weekday';
  }
  return null;
}

/**
 * Why the goodnight announcement should be skipped: already-posted first, then
 * no player-character activity today. Null = post normally.
 */
export function goodnightSkipReason(input: {
  alreadyPosted: boolean;
  activePlayersToday: number;
}): 'already-posted' | 'no-activity' | null {
  if (input.alreadyPosted) return 'already-posted';
  if (input.activePlayersToday === 0) return 'no-activity';
  return null;
}
