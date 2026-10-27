import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFolders } from '../src/choose.ts';
import { diagramAt } from '../src/commands.ts';
import { loadConfig } from '../src/config.ts';
import { extract } from '../src/scan.ts';

const tmp = () => mkdtemp(join(tmpdir(), 'trawl-'));

describe('loadConfig', () => {
  test('expands ~ in roots', async () => {
    const path = join(await tmp(), 'config.json');
    await writeFile(path, '{"roots": ["~/code", "/abs"]}');
    expect(await loadConfig(path)).toEqual({ roots: [join(homedir(), 'code'), '/abs'] });
  });

  test('missing file means no roots', async () => {
    expect(await loadConfig(join(await tmp(), 'nope.json'))).toEqual({ roots: [] });
  });

  test('rejects malformed roots', async () => {
    const path = join(await tmp(), 'config.json');
    await writeFile(path, '{"roots": "~/code"}');
    await expect(loadConfig(path)).rejects.toThrow('"roots" must be a list');
  });
});

describe('diagramAt', () => {
  const md = '# A\n```mermaid\ngraph TD\n  A\n```\n\n# B\n```mermaid\ngraph TD\n  B\n```\n';
  const diagrams = extract('/a.md', md);

  test('picks the diagram at or above the line, counting the fence line', () => {
    expect(diagramAt(diagrams, 2)?.title).toBe('A'); // the ```mermaid line itself
    expect(diagramAt(diagrams, 7)?.title).toBe('A'); // between diagrams: the one above
    expect(diagramAt(diagrams, 8)?.title).toBe('B');
    expect(diagramAt(diagrams, 99)?.title).toBe('B');
  });

  test('nothing above the first fence', () => {
    expect(diagramAt(diagrams, 1)).toBeUndefined();
  });
});

describe('listFolders', () => {
  test('walks to the depth limit, skipping dot-dirs and node_modules', async () => {
    const root = await tmp();
    for (const d of ['a/b/c', '.git/x', 'node_modules/y']) await mkdir(join(root, d), { recursive: true });
    const rel = (await listFolders([root], 2)).map((f) => f.slice(root.length) || '/');
    expect(rel.sort()).toEqual(['/', '/a', '/a/b']);
  });
});
