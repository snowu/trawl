import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
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
    for (const file of await findMarkdown(root)) files.add(file);
  }

  const sorted = [...files].sort();
  const texts = await Promise.all(sorted.map((f) => Bun.file(f).text()));
  return sorted.flatMap((file, i) => extract(file, texts[i]));
}

/**
 * Every .md/.mmd file under root. Prunes dot-dirs and SKIP_DIRS without entering them (a glob walks
 * every node_modules first and filters after: 33s vs <1s on a ~/code full of repos), and walks
 * sibling folders in parallel. Symlinked folders are not followed, so link cycles can't loop.
 */
async function findMarkdown(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((e) => {
      const path = join(root, e.name);
      if (e.isDirectory()) return e.name.startsWith('.') || SKIP_DIRS.has(e.name) ? [] : findMarkdown(path);
      return e.isFile() && /\.(md|mmd)$/.test(e.name) ? [path] : [];
    }),
  );
  return nested.flat();
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
