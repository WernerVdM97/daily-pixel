import yaml from 'js-yaml';
import fs from 'node:fs';

export class YamlLoadError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly cause?: unknown,
  ) {
    super(`YAML load error in ${filePath}: ${message}`);
    this.name = 'YamlLoadError';
  }
}

/**
 * Loads a YAML file and returns its parsed content as an array of unknown records.
 * Fail-fast: throws YamlLoadError on missing file, invalid YAML, non-array, or empty array.
 * Schema validation is done by the caller via a type assertion / validation function.
 */
export function loadYamlFile(filePath: string): unknown[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new YamlLoadError('File not found or unreadable', filePath, e);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    throw new YamlLoadError('Invalid YAML syntax', filePath, e);
  }

  if (!Array.isArray(parsed)) {
    throw new YamlLoadError('Expected a YAML array (list of entries)', filePath);
  }

  if (parsed.length === 0) {
    throw new YamlLoadError('YAML array must not be empty', filePath);
  }

  return parsed;
}
