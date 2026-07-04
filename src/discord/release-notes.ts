/**
 * Player-facing release notes.
 *
 * One YAML file per release tag lives in `assets/release-notes/<tag>.yml`
 * (e.g. `v0.2.3.yml`). When the bot boots on a tag it hasn't announced before
 * (see the `last_release_announced` meta key), it posts the matching notes to
 * the announcement channel with a feedback/request button — so players, not
 * just the changelog, hear what changed. Keep the content **non-technical**:
 * what's new and fun, not migrations and refactors.
 *
 * No file for the current tag → nothing is announced (and the meta is left
 * untouched, so dropping a notes file in later still fires on the next boot).
 */
import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";

export interface ReleaseNotes {
  /** The release tag, e.g. "v0.2.3". Defaults to the requested tag if omitted. */
  tag: string;
  title: string;
  date?: string;
  /** Non-technical "what's new" bullets. */
  highlights: string[];
  /** Optional free-text blurb shown under the highlights. */
  notes?: string;
}

/**
 * Load the release-notes for a tag, or null when there's no (valid) file for
 * it. Never throws — a missing or malformed file degrades to "no notes" (and is
 * logged) so a bad file can't crash boot.
 */
export function loadReleaseNotes(tag: string, dir: string): ReleaseNotes | null {
  const file = path.join(dir, `${tag}.yml`);

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null; // no notes for this tag
  }

  try {
    const parsed = yaml.load(raw) as Partial<ReleaseNotes> | undefined;
    if (
      !parsed ||
      typeof parsed.title !== "string" ||
      !Array.isArray(parsed.highlights) ||
      parsed.highlights.length === 0
    ) {
      console.warn(
        `[release-notes] ${file} is missing required fields (title, non-empty highlights) — skipping.`,
      );
      return null;
    }
    return {
      tag: typeof parsed.tag === "string" ? parsed.tag : tag,
      title: parsed.title,
      date: typeof parsed.date === "string" ? parsed.date : undefined,
      highlights: parsed.highlights.filter(
        (h): h is string => typeof h === "string",
      ),
      notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
    };
  } catch (e) {
    console.warn(
      `[release-notes] failed to parse ${file}:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/** Build the public release-notes message body. */
export function buildReleaseNotesMessage(rn: ReleaseNotes): string {
  const lines: string[] = [`📬 **What's New — ${rn.tag}: ${rn.title}**`];
  if (rn.date) lines.push(`*${rn.date}*`);
  lines.push("");
  for (const h of rn.highlights) lines.push(`• ${h}`);
  if (rn.notes) {
    lines.push("");
    lines.push(rn.notes);
  }
  lines.push("");
  lines.push(
    "💬 Got an idea or a gripe? Tap **Request / Feedback** below — the warden is listening.",
  );
  return lines.join("\n");
}
