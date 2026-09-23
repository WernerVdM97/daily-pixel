/**
 * Files are read once (lazily) into a cached Buffer, and each call returns a fresh
 * AttachmentBuilder from it; a missing/unreadable file degrades to `null` rather than throwing.
 */
import { AttachmentBuilder } from 'discord.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, '..', '..', 'assets', 'ui');

/** Square shot of the Oak — used as the onboarding (/join) thumbnail. */
export const OAK_IMAGE = 'theoak.png';
/** Wide banner — used on the admin /sleep day-tick announcement. */
export const BANNER_IMAGE = 'daily-pixel-banner.png';

const cache = new Map<string, Buffer | null>();

function load(name: string): Buffer | null {
  if (!cache.has(name)) {
    try {
      cache.set(name, readFileSync(path.join(UI_DIR, name)));
    } catch {
      cache.set(name, null);
    }
  }
  return cache.get(name) ?? null;
}

/** A fresh AttachmentBuilder for `name`, or `null` if the file is unavailable. */
export function imageAttachment(name: string): AttachmentBuilder | null {
  const buf = load(name);
  return buf ? new AttachmentBuilder(buf, { name }) : null;
}

/** Files array for a reply — `[attachment]` when available, else `[]`. */
export function imageFiles(name: string): AttachmentBuilder[] {
  const att = imageAttachment(name);
  return att ? [att] : [];
}

/** Whether `name` is available to reference via `attachment://`. */
export function hasImage(name: string): boolean {
  return load(name) !== null;
}
