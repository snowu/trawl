import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDoc, replaceDiagramSource, slug } from '../src/markdown.ts';
import { findDiagram, findSection, parseRef } from '../src/refs.ts';
import { ftsQuery, Store } from '../src/store.ts';

const DOC = `---
title: Checkout spec
owner: product
---
intro text

# Checkout

## Flow

\`\`\`mermaid id=checkout-flow
flowchart LR
  cart --> pay
\`\`\`

\`\`\`python
# not a heading
\`\`\`

## Flow

\`\`\`mermaid
sequenceDiagram
  A->>B: hi
\`\`\`

\`\`\`mermaid
%% trawl:id retries
flowchart TD
  a --> b
\`\`\`

### Edge cases

See [refunds](./refunds.md#call) and [web](https://x.dev/a.md).
`;

describe('parseDoc', () => {
  const doc = parseDoc('/d/spec.md', DOC);

  test('title and flat frontmatter', () => {
    expect(doc.title).toBe('Checkout spec');
    expect(doc.frontmatter).toEqual({ title: 'Checkout spec', owner: 'product' });
  });

  test('sections with breadcrumbs; # lines inside code fences are not headings', () => {
    expect(doc.sections.map((s) => [s.line, s.level, s.crumb])).toEqual([
      [5, 0, 'spec.md'],
      [7, 1, 'Checkout'],
      [9, 2, 'Checkout › Flow'],
      [20, 2, 'Checkout › Flow'],
      [33, 3, 'Checkout › Flow › Edge cases'],
    ]);
    expect(doc.sections[2].body).toContain('# not a heading');
  });

  test('diagram ids: fence attribute, %% comment, derived from heading', () => {
    expect(doc.diagrams.map((d) => [d.id, d.explicitId, d.line])).toEqual([
      ['checkout-flow', true, 12],
      ['flow', false, 23],
      ['retries', true, 28],
    ]);
  });

  test('repeated headings get numbered ids', () => {
    const d = parseDoc('/x.md', '## A\n```mermaid\nflowchart LR\na-->b\n```\n## A\n```mermaid\nflowchart LR\nc-->d\n```\n');
    expect(d.diagrams.map((x) => x.id)).toEqual(['a', 'a-2']);
  });

  test('relative markdown links only', () => {
    expect(doc.links).toEqual(['./refunds.md']);
  });

  test('slug', () => {
    expect(slug('Order Lifecycle (v2)')).toBe('order-lifecycle-v2');
    expect(slug('Café — ünïcode')).toBe('cafe-unicode');
    expect(slug('!!!')).toBe('diagram');
  });
});

describe('refs', () => {
  const doc = parseDoc('/d/spec.md', DOC);

  test('parseRef', () => {
    expect(parseRef('/d/spec.md:12')).toEqual({ file: '/d/spec.md', line: 12, anchor: undefined });
    expect(parseRef('/d/spec.md#checkout-flow')).toEqual({ file: '/d/spec.md', line: undefined, anchor: 'checkout-flow' });
  });

  test('findDiagram by id, by line, and errors listing ids', () => {
    expect(findDiagram(doc, { file: doc.file, anchor: 'retries' }).line).toBe(28);
    expect(findDiagram(doc, { file: doc.file, line: 25 }).id).toBe('flow');
    expect(() => findDiagram(doc, { file: doc.file })).toThrow(/checkout-flow, flow, retries/);
    expect(() => findDiagram(doc, { file: doc.file, anchor: 'nope' })).toThrow(/no diagram with id "nope"/);
  });

  test('findSection by line, heading slug, or diagram id', () => {
    expect(findSection(doc, { file: doc.file, line: 34 })?.heading).toBe('Edge cases');
    expect(findSection(doc, { file: doc.file, anchor: 'edge-cases' })?.line).toBe(33);
    expect(findSection(doc, { file: doc.file, anchor: 'retries' })?.line).toBe(20);
    expect(findSection(doc, { file: doc.file })).toBeUndefined();
  });
});

describe('replaceDiagramSource', () => {
  test('swaps only the diagram body', () => {
    const doc = parseDoc('/d/spec.md', DOC);
    const out = replaceDiagramSource(DOC, doc.diagrams[0], 'flowchart LR\n  cart --> pay --> done\n');
    expect(out).toContain('```mermaid id=checkout-flow\nflowchart LR\n  cart --> pay --> done\n```');
    expect(parseDoc('/d/spec.md', out).diagrams).toHaveLength(3);
    expect(out.replace('pay --> done', 'pay')).toBe(DOC);
  });

  test('refuses when the file changed under it', () => {
    const doc = parseDoc('/d/spec.md', DOC);
    expect(() => replaceDiagramSource(DOC.replace('cart --> pay', 'cart --> x'), doc.diagrams[0], 'x')).toThrow(/changed/);
  });

  test('.mmd files are replaced whole', () => {
    const doc = parseDoc('/d/a.mmd', 'flowchart LR\na-->b\n');
    expect(replaceDiagramSource('flowchart LR\na-->b\n', doc.diagrams[0], 'flowchart LR\nb-->c')).toBe('flowchart LR\nb-->c\n');
  });
});

describe('Store', () => {
  let dir: string;
  let store: Store;
  afterEach(async () => {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'trawl-index-'));
    await mkdir(join(dir, 'a/node_modules'), { recursive: true });
    await mkdir(join(dir, 'b'), { recursive: true });
    await writeFile(join(dir, 'a/spec.md'), DOC);
    await writeFile(join(dir, 'a/node_modules/skip.md'), '# Checkout skipped\n');
    await writeFile(join(dir, 'b/notes.md'), '# Notes\n\nRefunds go through the payments team.\n');
    store = new Store(':memory:');
  }

  test('indexes, searches with headings first, scopes by root', async () => {
    await setup();
    expect(await store.refresh([dir])).toEqual({ files: 2, updated: 2, removed: 0 });
    const hits = store.search('checkout');
    expect(hits[0].heading).toBe('Checkout');
    expect(hits.every((h) => !h.file.includes('node_modules'))).toBe(true);
    expect(store.search('refunds', { roots: [join(dir, 'b')] }).map((h) => h.heading)).toEqual(['Notes']);
    expect(store.search('refunds', { roots: [join(dir, 'b')] })[0].snippet).toContain('«Refunds»');
    expect(store.search('refund')).toHaveLength(2); // prefix + stemming: "refunds" in both files
    expect(store.diagrams([dir]).map((d) => d.id)).toEqual(['checkout-flow', 'flow', 'retries']);
  });

  test('refresh re-reads only changed files and drops deleted ones', async () => {
    await setup();
    await store.refresh([dir]);
    expect(await store.refresh([dir])).toEqual({ files: 2, updated: 0, removed: 0 });
    await Bun.sleep(5);
    await writeFile(join(dir, 'b/notes.md'), '# Notes\n\nNow about invoices.\n');
    await rm(join(dir, 'a/spec.md'));
    expect(await store.refresh([dir])).toEqual({ files: 1, updated: 1, removed: 1 });
    expect(store.search('refunds')).toHaveLength(0);
    expect(store.search('invoices')).toHaveLength(1);
    expect(store.diagrams()).toHaveLength(0);
  });

  test('refreshing one root leaves other roots alone', async () => {
    await setup();
    await store.refresh([dir]);
    await store.refresh([join(dir, 'b')]);
    expect(store.docs().length).toBe(2);
  });

  test('recent lists docs newest first', async () => {
    await setup();
    await store.refresh([dir]);
    expect(store.recent().map((h) => h.docTitle).sort()).toEqual(['Checkout spec', 'Notes']);
  });

  test('query syntax in user input is neutralised', () => {
    expect(ftsQuery('foo-bar "x" a.md OR')).toBe('"foo"* "bar"* "x"* "a"* "md"* "OR"*');
    expect(ftsQuery('  ')).toBe('');
  });
});
