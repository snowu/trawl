import { describe, expect, test } from 'bun:test';
import { check, formatProblem } from '../src/commands.ts';
import { inlineCssVars, svgToPng, toAscii, toSvg } from '../src/render.ts';
import { extract } from '../src/scan.ts';
import { filterDiagrams } from '../src/ui.tsx';

const FLOW = 'flowchart LR\n  A[Start] --> B[End]';

describe('inlineCssVars', () => {
  test('resolves nested vars and fallbacks', () => {
    const svg = '<svg style="--_fg:var(--pele-fg,#111);color:var(--_fg)"><rect fill="var(--missing, #abc)"/></svg>';
    expect(inlineCssVars(svg)).toBe('<svg style="--_fg:#111;color:#111"><rect fill="#abc"/></svg>');
  });

  // resvg can't read CSS vars: any left over render as black boxes / missing edges.
  test('leaves no var() in real pele output', () => {
    expect(inlineCssVars(toSvg(FLOW))).not.toContain('var(');
  });
});

describe('rendering', () => {
  test('produces a PNG', async () => {
    const png = await svgToPng(toSvg(FLOW));
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('ascii ignores frontmatter', () => {
    expect(toAscii(`---\ntitle: x\n---\n${FLOW}`)).toContain('Start');
  });
});

describe('check', () => {
  test('reports only broken diagrams, at the offending file line', () => {
    const broken = 'sequenceDiagram\n  A->>B: hi\n  Note over A: x;y';
    const diagrams = extract('/a.md', `\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n\`\`\`mermaid\n${broken}\n\`\`\`\n`);
    const [problem, ...rest] = check(diagrams);
    expect(rest).toHaveLength(0);
    expect(problem.diagram.line).toBe(7);
    expect(problem.line).toBe(9);
    expect(formatProblem(problem)).toStartWith('/a.md:9:   Note over A: x;y\n    ');
  });
});

describe('filterDiagrams', () => {
  const diagrams = [...extract('/repo/docs/a.md', '## Login\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n'),
    ...extract('/repo/docs/flow.mmd', FLOW)];

  test('matches every term across title, path and type', () => {
    expect(filterDiagrams(diagrams, 'login seq').map((d) => d.title)).toEqual(['Login']);
    expect(filterDiagrams(diagrams, 'FLOWCHART').map((d) => d.title)).toEqual(['flow']);
    expect(filterDiagrams(diagrams, '')).toHaveLength(2);
  });
});
