import { describe, it, expect } from 'vitest';
import { loadYamlFile, YamlLoadError } from '../../src/assets/yaml-loader.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'warden-test-'));
}

function writeFile(dir: string, name: string, content: string) {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

describe('loadYamlFile', () => {
  it('loads and validates a valid YAML array', () => {
    const dir = tmpDir();
    writeFile(dir, 'classes.yml', `
- name: Warrior
  description: Front line.
  modifiers: { physical: 3, wisdom: -1, intelligence: 0, charisma: 0 }
- name: Ranger
  description: Wilds.
  modifiers: { physical: 1, wisdom: 2, intelligence: 0, charisma: -1 }
`);
    const result = loadYamlFile(path.join(dir, 'classes.yml'));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: 'Warrior',
      description: 'Front line.',
      modifiers: { physical: 3, wisdom: -1, intelligence: 0, charisma: 0 },
    });
  });

  it('throws YamlLoadError for missing file', () => {
    expect(() => loadYamlFile('/nonexistent/path.yml'))
      .toThrow(YamlLoadError);
    try {
      loadYamlFile('/nonexistent/path.yml');
    } catch (e) {
      expect(e).toBeInstanceOf(YamlLoadError);
      expect((e as YamlLoadError).message).toContain('not found');
    }
  });

  it('throws YamlLoadError for invalid YAML syntax', () => {
    const dir = tmpDir();
    writeFile(dir, 'bad.yml', '{{ invalid: yaml: : }\n');
    expect(() => loadYamlFile(path.join(dir, 'bad.yml')))
      .toThrow(YamlLoadError);
  });

  it('throws YamlLoadError for non-array YAML', () => {
    const dir = tmpDir();
    writeFile(dir, 'scalar.yml', 'hello world\n');
    expect(() => loadYamlFile(path.join(dir, 'scalar.yml')))
      .toThrow(YamlLoadError);
  });

  it('throws YamlLoadError for empty array', () => {
    const dir = tmpDir();
    writeFile(dir, 'empty.yml', '[]\n');
    expect(() => loadYamlFile(path.join(dir, 'empty.yml')))
      .toThrow(YamlLoadError);
  });
});
