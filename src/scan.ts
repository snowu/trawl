import { Glob } from 'bun';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import { detectType } from 'pele';

export interface Diagram {
  /** Absolute path of the file holding the diagram. */
  file: string;
  /** 1-based line of the diagram's first source line. */
  line: number;
  /** Nearest markdown heading above the fence, or the file name for .mmd files. */
  title: string;
  /** Diagram kind as detected by pele (flowchart, sequence, ...), or null when unknown. */
  type: string | null;
  source: string;
}

export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', '__pycache__']);
const FENCE_OPEN = /^\s*(```+|~~~+)\s*mermaid\b/;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;

/** Extracts every mermaid diagram from a markdown or .mmd file's text. */
export function extract(file: string, text: string): Diagram[] {
  if (file.endsWith('.mmd')) {
    const title = file.split('/').pop()!.replace(/\.mmd$/, '');
    return [{ file, line: 1, title, type: detectType(text), source: text }];
  }

  const lines = text.split('\n');
  const diagrams: Diagram[] = [];
  let heading = file.split('/').pop()!;
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (h) heading = h[1];
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) continue;

    const fence = open[1];
    const start = i + 1;
    let end = start;
    while (end < lines.length && !lines[end].trimStart().startsWith(fence)) end++;
    const source = lines.slice(start, end).join('\n');
    diagrams.push({ file, line: start + 1, title: heading, type: detectType(source), source });
    i = end;
  }
  return diagrams;
}

/** Finds all mermaid diagrams under the given directories (or files), sorted by path and line. */
export async function scan(paths: string[]): Promise<Diagram[]> {
  const files = new Set<string>();
  for (const p of paths) {
    const root = resolve(p);
    if (/\.(md|mmd)$/.test(root)) {
      files.add(root);
      continue;
    }
    // Glob skips dot-dirs (.git, .venv, ...) by default.
    for await (const rel of new Glob('**/*.{md,mmd}').scan({ cwd: root, onlyFiles: true })) {
      if (rel.split('/').some((part) => SKIP_DIRS.has(part))) continue;
      files.add(resolve(root, rel));
    }
  }

  const diagrams: Diagram[] = [];
  for (const file of [...files].sort()) {
    diagrams.push(...extract(file, await Bun.file(file).text()));
  }
  return diagrams;
}

/** `/home/me/x` -> `~/x` */
export function tildePath(path: string): string {
  return path.startsWith(homedir() + '/') ? `~${path.slice(homedir().length)}` : path;
}

/** Path shown to the user: relative to cwd when inside it, else ~-relative. */
export function displayPath(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel.startsWith('..') ? tildePath(file) : rel;
}
