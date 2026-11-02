import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagramDiff, lineDiff, prComment, renderChanges } from '../src/diff.ts';
import { buildSite, githubUrl } from '../src/site.ts';

let dir: string;
const sh = (...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (!r.success) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

const SPEC = `---
owner: product
---
# Checkout

<script>alert(1)</script>

See [refunds](flows/refunds.md#call) and ![logo](img/logo.png).

## Flow

\`\`\`mermaid id=checkout-flow
flowchart LR
  cart --> pay
\`\`\`

## Broken

\`\`\`mermaid
flowchart LR
  a -->
\`\`\`
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trawl-site-'));
  await mkdir(join(dir, 'flows'), { recursive: true });
  await mkdir(join(dir, 'img'), { recursive: true });
  await mkdir(join(dir, '.trawl'), { recursive: true });
  await writeFile(join(dir, 'spec.md'), SPEC);
  await writeFile(join(dir, 'flows/refunds.md'), '# Refunds\n\n## Call\n\n```mermaid\nsequenceDiagram\n  A->>B: refund\n```\n');
  await writeFile(join(dir, 'img/logo.png'), 'png');
  await writeFile(join(dir, '.trawl/links.json'), JSON.stringify({ 'spec.md#checkout-flow': 'https://www.figma.com/board/abc' }));
  sh('init', '-q', '-b', 'main');
  sh('add', '-A');
  sh('commit', '-qm', 'init');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('buildSite', () => {
  test('docs, diagrams, links, figma, escaping, assets', async () => {
    const out = join(dir, '_site');
    const { data, problems } = await buildSite({ paths: [dir], root: dir, out, repo: { url: 'https://github.com/o/r', branch: 'main' } });
    expect(data.docs.map((d) => d.path)).toEqual(['flows/refunds.md', 'spec.md']);
    expect(data.diagrams.map((d) => d.key)).toEqual(['flows/refunds.md#call', 'spec.md#checkout-flow', 'spec.md#broken']);
    expect(problems).toHaveLength(1);

    const flow = data.diagrams.find((d) => d.id === 'checkout-flow')!;
    expect(flow.figma).toBe('https://www.figma.com/board/abc');
    expect(await Bun.file(join(out, flow.svg!)).text()).toStartWith('<svg');
    expect((await Bun.file(join(out, flow.png!)).bytes()).subarray(1, 4).toString()).toBe('80,78,71'); // "PNG"
    expect(data.diagrams.find((d) => d.id === 'broken')!.error).toBeTruthy();

    const html = data.docs.find((d) => d.path === 'spec.md')!.html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="#/doc/flows/refunds.md/call"');
    expect(html).toContain('src="files/img/logo.png"');
    expect(html).toContain('<figure class="diagram" data-key="spec.md#checkout-flow">');
    expect(html).not.toContain('owner: product');
    expect(await Bun.file(join(out, 'files/img/logo.png')).exists()).toBe(true);
    expect(await Bun.file(join(out, 'index.html')).text()).toContain('fetch(\'trawl.json\')');
  });

  test('githubUrl', () => {
    expect(githubUrl('git@github.com:snowu/trawl.git')).toBe('https://github.com/snowu/trawl');
    expect(githubUrl('https://github.com/snowu/trawl')).toBe('https://github.com/snowu/trawl');
    expect(githubUrl('https://gitlab.com/x/y.git')).toBeNull();
  });
});

describe('diagramDiff', () => {
  test('added, changed, removed (by id), against the working tree and a commit', async () => {
    sh('checkout', '-qb', 'feature');
    await writeFile(join(dir, 'spec.md'), SPEC.replace('cart --> pay', 'cart --> pay --> done').replace(/## Broken[\s\S]*$/, ''));
    await writeFile(join(dir, 'flows/new.md'), '# New\n\n```mermaid\nflowchart TD\n  x --> y\n```\n');

    const wt = await diagramDiff(dir, 'main');
    expect(wt.map((c) => `${c.status} ${c.file}#${c.id}`).sort()).toEqual([
      'added flows/new.md#new',
      'changed spec.md#checkout-flow',
      'removed spec.md#broken',
    ]);

    sh('add', '-A');
    sh('commit', '-qm', 'change');
    const committed = await diagramDiff(dir, 'main', 'feature');
    expect(committed).toHaveLength(3);

    const out = join(dir, '_previews');
    await renderChanges(committed, out);
    const changed = committed.find((c) => c.status === 'changed')!;
    expect(changed.beforePng).toBeTruthy();
    expect(changed.afterPng).toBeTruthy();
    expect(committed.find((c) => c.status === 'removed')!.beforeError).toBeTruthy();

    const md = prComment(committed, { imageUrl: 'https://img.example/pr-1' });
    expect(md).toStartWith('<!-- trawl-diagram-diff -->');
    expect(md).toContain('| Before | After |');
    expect(md).toContain(`https://img.example/pr-1/${encodeURIComponent(changed.afterPng!)}`);
    expect(md).toContain('+  cart --> pay --> done');
    expect(md).toContain("doesn't parse");
  });

  test('no changes', () => {
    expect(prComment([])).toContain('No diagram changes');
  });
});

test('lineDiff', () => {
  expect(lineDiff('a\nb\nc', 'a\nx\nc')).toBe(' a\n-b\n+x\n c');
});
