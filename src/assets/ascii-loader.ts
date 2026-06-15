import yaml from 'js-yaml';
import fs from 'node:fs';

export class AsciiLoadError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly cause?: unknown,
  ) {
    super(`ASCII load error in ${filePath}: ${message}`);
    this.name = 'AsciiLoadError';
  }
}

export interface AsciiFile {
  tags: string[];
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Loads a .ascii file with YAML frontmatter.
 * Fail-fast: throws AsciiLoadError on missing file, missing/bad frontmatter, missing tags, or empty body.
 */
export function loadAsciiFile(filePath: string): AsciiFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new AsciiLoadError('File not found or unreadable', filePath, e);
  }

  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new AsciiLoadError('Missing or malformed YAML frontmatter (expected --- ... ---)', filePath);
  }

  const [, fmRaw, bodyRaw] = match;

  let frontmatter: unknown;
  try {
    frontmatter = yaml.load(fmRaw);
  } catch (e) {
    throw new AsciiLoadError('Invalid YAML in frontmatter', filePath, e);
  }

  if (typeof frontmatter !== 'object' || frontmatter === null) {
    throw new AsciiLoadError('Frontmatter must be a YAML mapping', filePath);
  }

  const fm = frontmatter as Record<string, unknown>;

  if (!Array.isArray(fm.tags) || fm.tags.length === 0) {
    throw new AsciiLoadError('Frontmatter must contain a non-empty "tags" array', filePath);
  }

  const tags = fm.tags as string[];
  const body = bodyRaw.trimEnd();

  if (body.length === 0) {
    throw new AsciiLoadError('ASCII body must not be empty', filePath);
  }

  return { tags, body };
}
