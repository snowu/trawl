import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract, scan } from '../src/scan.ts';

const MD = `# Title

intro

## Flow

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

\`\`\`python
print("not a diagram")
\`\`\`

## Calls

~~~mermaid
sequenceDiagram
  A->>B: hi
~~~
`;

describe('extract', () => {
  test('finds mermaid fences with nearest heading, line and type', () => {
    const diagrams = extract('/docs/a.md', MD);
    expect(diagrams.map(({ line, title, type }) => ({ line, title, type }))).toEqual([
      { line: 8, title: 'Flow', type: 'flowchart' },
      { line: 19, title: 'Calls', type: 'sequence' },
    ]);
    expect(diagrams[0].source).toBe('flowchart LR\n  A --> B');
  });

  test('falls back to the file name when no heading precedes the fence', () => {
    expect(extract('/docs/b.md', '```mermaid\ngraph TD\n  A\n```')[0].title).toBe('b.md');
  });

  test('treats a whole .mmd file as one diagram', () => {
    const [d] = extract('/x/flow.mmd', 'graph TD\n  A --> B\n');
    expect(d).toMatchObject({ line: 1, title: 'flow', type: 'flowchart' });
  });

  test('ignores ``` inside a ~~~ fence', () => {
    const diagrams = extract('/c.md', '~~~mermaid\ngraph TD\n  A["```"]\n~~~\n');
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].source).toBe('graph TD\n  A["```"]');
  });
});

describe('scan', () => {
  test('walks directories, skipping dot-dirs and node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trawl-'));
    for (const dir of ['docs', '.git', 'node_modules/pkg']) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, 'docs/a.md'), MD);
    await writeFile(join(root, 'docs/b.mmd'), 'graph TD\n  A\n');
    await writeFile(join(root, '.git/c.md'), MD);
    await writeFile(join(root, 'node_modules/pkg/d.md'), MD);

    const diagrams = await scan([root]);
    expect(diagrams.map((d) => d.file.slice(root.length + 1))).toEqual(['docs/a.md', 'docs/a.md', 'docs/b.mmd']);
  });
});
