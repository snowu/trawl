import { expect, test } from 'bun:test';
import { drawDiagrams } from '../src/find.ts';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const FLOW = 'Intro\n\n```mermaid\nflowchart LR\n  a[Cart] --> b[Pay]\n```\n\nAfter.';

test('draws diagrams that fit as box art, keeping the text around them', () => {
  const out = strip(drawDiagrams(FLOW, 200));
  expect(out).toContain('◆ flowchart');
  expect(out).toContain('Cart');
  expect(out).not.toContain('```mermaid');
  expect(out).toStartWith('Intro');
  expect(out).toEndWith('After.');
});

test('too wide, unsupported type or broken: keeps the source with a note', () => {
  expect(strip(drawDiagrams(FLOW, 10))).toMatch(/too wide to draw here \(\d+ cols\)[\s\S]*```mermaid/);
  const gantt = '```mermaid\ngantt\n  title T\n  dateFormat YYYY-MM-DD\n  section S\n  A :a1, 2026-01-01, 3d\n```';
  expect(strip(drawDiagrams(gantt))).toContain('gantt: no text preview');
  const broken = strip(drawDiagrams('```mermaid\nflowchart LR\n  a -->\n```'));
  expect(broken).toMatch(/✗ doesn't parse \(diagram line 2\): Expecting/);
  expect(broken).toContain('a -->');
});
