import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, PeleError } from 'pele';
import { svgToPng, toSvg } from './render.ts';
import { type Diagram, displayPath } from './scan.ts';

export interface Problem {
  diagram: Diagram;
  /** 1-based line in the file: the offending line when known, else the diagram's first line. */
  line: number;
  message: string;
}

function toProblem(diagram: Diagram, e: unknown): Problem {
  if (e instanceof PeleError && e.line > 0) {
    // Drop pele's "Parse error on line N:" header; N is relative to the diagram, we report the file line.
    const message = e.message.replace(/^Parse error on line \d+:\n/, '');
    return { diagram, line: diagram.line + e.line - 1, message };
  }
  return { diagram, line: diagram.line, message: e instanceof Error ? e.message : String(e) };
}

/** Parses every diagram and returns the ones mermaid syntax rejects. */
export function check(diagrams: Diagram[]): Problem[] {
  const problems: Problem[] = [];
  for (const diagram of diagrams) {
    try {
      parse(diagram.source);
    } catch (e) {
      problems.push(toProblem(diagram, e));
    }
  }
  return problems;
}

/** `path:line: first message line`, with any further lines (snippet, caret) indented below. */
export function formatProblem({ diagram, line, message }: Problem): string {
  const [first, ...rest] = message.split('\n');
  return [`${displayPath(diagram.file)}:${line}: ${first}`, ...rest.map((l) => `    ${l}`)].join('\n');
}

/** The diagram whose fence starts at or above `line` (1-based), closest first; undefined if none. */
export function diagramAt(diagrams: Diagram[], line: number): Diagram | undefined {
  return diagrams.filter((d) => d.line - 1 <= line).at(-1);
}

/** `docs/a.md` line 12 -> `docs__a.md-12` */
export function outputName(diagram: Diagram): string {
  return `${displayPath(diagram.file).replace(/^\/+/, '').replaceAll('/', '__')}-${diagram.line}`;
}

/** Renders every diagram into outDir; returns the problems for diagrams that failed. */
export async function renderAll(diagrams: Diagram[], outDir: string, format: 'svg' | 'png'): Promise<Problem[]> {
  await mkdir(outDir, { recursive: true });
  const problems: Problem[] = [];
  for (const diagram of diagrams) {
    try {
      const svg = toSvg(diagram.source);
      await Bun.write(join(outDir, `${outputName(diagram)}.${format}`), format === 'svg' ? svg : await svgToPng(svg));
    } catch (e) {
      problems.push(toProblem(diagram, e));
    }
  }
  return problems;
}
