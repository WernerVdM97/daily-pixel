import { describe, it, expect } from 'vitest';
import { loadAsciiFile, AsciiLoadError } from '../../src/assets/ascii-loader.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ascii-'));
}

function writeFile(dir: string, name: string, content: string) {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

describe('loadAsciiFile', () => {
  it('parses frontmatter tags and body content', () => {
    const dir = tmpDir();
    writeFile(dir, 'oak.ascii', `---
tags: [oak, interior, fire, sanctuary]
---
     ,@@@@@@,
  ,@@@@@@@@@@,
   @@@@  @@@@
`);
    const result = loadAsciiFile(path.join(dir, 'oak.ascii'));
    expect(result.tags).toEqual(['oak', 'interior', 'fire', 'sanctuary']);
    expect(result.body).toContain(',@@@@@@,');
    expect(result.body).toContain('@@@@  @@@@');
  });

  it('throws AsciiLoadError for missing file', () => {
    expect(() => loadAsciiFile('/nonexistent/file.ascii'))
      .toThrow(AsciiLoadError);
  });

  it('throws AsciiLoadError when frontmatter is missing', () => {
    const dir = tmpDir();
    writeFile(dir, 'nofm.ascii', 'just some ascii\nno frontmatter\n');
    expect(() => loadAsciiFile(path.join(dir, 'nofm.ascii')))
      .toThrow(AsciiLoadError);
  });

  it('throws AsciiLoadError when tags are missing from frontmatter', () => {
    const dir = tmpDir();
    writeFile(dir, 'notags.ascii', `---
description: no tags here
---
some body
`);
    expect(() => loadAsciiFile(path.join(dir, 'notags.ascii')))
      .toThrow(AsciiLoadError);
  });

  it('throws AsciiLoadError when body is empty', () => {
    const dir = tmpDir();
    writeFile(dir, 'empty.ascii', `---
tags: [empty]
---
`);
    expect(() => loadAsciiFile(path.join(dir, 'empty.ascii')))
      .toThrow(AsciiLoadError);
  });

  it('trims trailing whitespace from body but preserves leading spaces', () => {
    const dir = tmpDir();
    writeFile(dir, 'space.ascii', `---
tags: [space]
---
  indented art  
`);
    const result = loadAsciiFile(path.join(dir, 'space.ascii'));
    expect(result.body).toBe('  indented art');
  });
});
