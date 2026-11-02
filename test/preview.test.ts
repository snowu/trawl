import { expect, test } from 'bun:test';
import { drawDiagrams } from '../src/find.ts';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const FLOW = 'Intro\n\n```mermaid\nflowchart LR\n  a[Cart] --> b[Pay]\n```\n\nAfter.';

test('draws diagrams that fit as box art, keeping the text around them', () => {
  const out = strip(drawDiagrams(FLOW, 200));
  expect(out).toContain('◆ flowchart');
  expect(out).toContain('Cart');
  expect(out).not.toContain('```mermaid');
  expect(out).not.toContain('│ flowchart');
  expect(out).toStartWith('Intro');
  expect(out).toEndWith('After.');
});

test('too wide, unsupported type or broken: keeps the source with a note', () => {
  expect(strip(drawDiagrams(FLOW, 10))).toMatch(/too wide here \(\d+ cols\)[\s\S]*│ flowchart LR/);
  const gantt = '```mermaid\ngantt\n  title T\n  dateFormat YYYY-MM-DD\n  section S\n  A :a1, 2026-01-01, 3d\n```';
  expect(strip(drawDiagrams(gantt))).toContain('gantt · no text preview');
  const broken = strip(drawDiagrams('```mermaid\nflowchart LR\n  a -->\n```'));
  expect(broken).toMatch(/✗ doesn't parse \(diagram line 2\): Expecting/);
  expect(broken).toContain('a -->');
});

import { highlight, renderTermMd } from '../src/term-md.ts';

test('renderTermMd: headings, lists, quotes, code, tables, links, query highlight', () => {
  const md = '# Title\n\nSome **bold** and `code` and [a link](https://x.dev).\n\n- one\n  - nested\n- [x] done\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n\n\nEnd refunds.';
  const out = strip(renderTermMd(md, { query: 'refund' }));
  expect(out).toContain('Title\n─────');
  expect(out).toContain('Some bold and code and a link.');
  expect(out).toContain('• one\n  ◦ nested\n• ☑ done');
  expect(out).toContain('▎ quoted');
  expect(out).toContain('│ 1 │ 2');
  expect(out).not.toContain('|---|');
  expect(out).toContain('╭─ ts\n│ const x = 1;\n╰─');
  expect(out).not.toMatch(/\n\n\n/);
  expect(renderTermMd('End refunds.', { query: 'refund' })).toContain('\x1b[1;30;43mrefunds\x1b[0m');
});

test('renderTermMd hands mermaid fences to the diagram callback', () => {
  expect(renderTermMd('a\n```mermaid\nflowchart LR\n  x-->y\n```\nb', { diagram: (s) => `<${s.split('\n')[0]}>` })).toBe('a\n<flowchart LR>\nb');
});

test('highlight ignores one-letter words and regex characters', () => {
  expect(highlight('a (b) refund', 'a (b')).toBe('a (b) refund');
});
