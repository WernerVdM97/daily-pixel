/**
 * Content + formatting for the midday (12:00 UTC) afternoon announcements:
 *
 * - **Saturday** — a wilderness threat. One of the unsafe locations is named,
 *   a themed hostile NPC is spawned there, and players are nudged to go engage.
 *   The location rotates week-by-week so the same spot isn't always "hot".
 * - **Wednesday & Sunday** — wealth + might leaderboards.
 *
 * All functions here are pure (data + string building) so they can be unit
 * tested; the scheduler in index.ts wires them to the engine and Discord.
 */
import type { Leaderboards } from "../engine/WorldEngine.js";

export interface WildernessThreat {
  /** Must match a seeded unsafe location name. */
  location: string;
  npc: { name: string; class: string; race?: string; description: string };
  /** One-line teaser woven into the announcement. */
  hint: string;
}

/**
 * Themed threats, one per seeded unsafe ("wilderness") location. The Saturday
 * beat rotates through these in order, one per week.
 */
export const WILDERNESS_THREATS: WildernessThreat[] = [
  {
    location: "The Dark Pines",
    npc: {
      name: "The Pale Stalker",
      class: "Beast",
      description:
        "A gaunt, too-tall thing that moves between the trunks without sound. Its eyes catch the light like a deer's — but nothing else about it is gentle.",
    },
    hint: "Hunters who went in after deer have not come back out. Something is using the dark of the canopy as a blind.",
  },
  {
    location: "The Broken Keep",
    npc: {
      name: "The Last Sentinel",
      class: "Wraith",
      description:
        "Armour rusted to lace, still standing its post centuries after the wall fell. It does not speak. It only bars the way, sword half-drawn.",
    },
    hint: "The stones are whispering again, and a cold has settled over the ruin that no fire will lift.",
  },
  {
    location: "The River Crossing",
    npc: {
      name: "The Ford Lurker",
      class: "Beast",
      description:
        "A slick, broad-backed shape that lies just under the ford's surface, patient as a stone, until something steps in to drink.",
    },
    hint: "The tracks at the bank stop at the water's edge and never climb out the far side.",
  },
  {
    location: "The East Road",
    npc: {
      name: "Crow, the Toll-Taker",
      class: "Brigand",
      race: "Human",
      description:
        "A lean rider in a feathered cloak who has decided the East Road is hers, and that every cart owes her passage — in coin or in blood.",
    },
    hint: "Fewer carts come back, and those that do are lighter than they left. The road has a new owner.",
  },
  {
    location: "The Forest Edge",
    npc: {
      name: "The Bramble Boar",
      class: "Beast",
      description:
        "A boar gone monstrous, its hide knotted with thorn and bracken, tusks the length of a forearm. It has stopped fearing the treeline.",
    },
    hint: "The field hands have pulled back from the boundary — something large has been tearing up the fences by night.",
  },
];

/** Week-of-epoch index, so the threat location advances once per calendar week. */
export function weeklyThreatIndex(now: Date): number {
  const epochDay = Math.floor(now.getTime() / 86_400_000);
  const week = Math.floor(epochDay / 7);
  const n = WILDERNESS_THREATS.length;
  return ((week % n) + n) % n;
}

/** The threat in play for the week containing `now`. */
export function pickWeeklyThreat(now: Date): WildernessThreat {
  return WILDERNESS_THREATS[weeklyThreatIndex(now)];
}

/** The Saturday threat announcement body. */
export function buildThreatAnnouncement(threat: WildernessThreat): string {
  return [
    "⚔️ **A threat stirs in the wild.**",
    "",
    `Word reaches the Oak of trouble out at **${threat.location}**. ${threat.hint}`,
    "",
    `**${threat.npc.name}** is abroad there. Steel yourself, gather your kit, and go meet it — or leave it to grow bolder.`,
    "",
    "🎲 The Oak is generous on the weekend — an **extra roll** is yours today.",
    "",
    "`/hi` to set out.",
  ].join("\n");
}

const STAT_LABEL: Record<string, string> = {
  physical: "Physical",
  wisdom: "Wisdom",
  intelligence: "Intelligence",
  charisma: "Charisma",
};

const RANK_MEDAL = ["🥇", "🥈", "🥉"];

function rankMarker(i: number): string {
  return RANK_MEDAL[i] ?? `${i + 1}.`;
}

/** The Wednesday/Sunday leaderboard announcement body. */
export function buildLeaderboardAnnouncement(boards: Leaderboards): string {
  const lines: string[] = ["📊 **The Reckoning** — where the souls of the Oak stand.", ""];

  lines.push("💰 **Richest**");
  if (boards.wealth.length === 0) {
    lines.push("  *No fortunes worth the telling — yet.*");
  } else {
    boards.wealth.forEach((e, i) => {
      lines.push(`  ${rankMarker(i)} **${e.name}** (${e.class}) — ${e.value} coin`);
    });
  }

  lines.push("");
  lines.push("💪 **Mightiest**");
  if (boards.might.length === 0) {
    lines.push("  *No legends made — yet.*");
  } else {
    boards.might.forEach((e, i) => {
      const stat = e.stat ? STAT_LABEL[e.stat] ?? e.stat : "";
      lines.push(
        `  ${rankMarker(i)} **${e.name}** (${e.class}) — ${stat} ${e.value >= 0 ? "+" : ""}${e.value}`,
      );
    });
  }

  lines.push("");
  lines.push("`/hi` to make your mark.");
  return lines.join("\n");
}
