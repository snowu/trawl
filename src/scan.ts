import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { CONFIG_PATH, expandHome } from './config.ts';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { type Diagram, parseDoc } from './markdown.ts';

export type { Diagram } from './markdown.ts';

/**
 * Folders never walked: dependencies, build output and caches (their markdown is other people's READMEs).
 * Dot-folders are skipped too, and `pkg/mod` (Go's module cache); add more with `ignore` in the config.
 */
export const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'third_party',
  'dist', 'build', 'out', 'target', '_build', 'DerivedData', 'Pods',
  '__pycache__', 'site-packages', 'venv', 'snap',
]);

let ignoreRules: { names: Set<string>; paths: string[] } | undefined;

/** `ignore` from the config: bare names skip folders with that name anywhere, paths skip that folder. */
function ignored(): { names: Set<string>; paths: string[] } {
  if (ignoreRules) return ignoreRules;
  ignoreRules = { names: new Set(), paths: [] };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { ignore?: unknown };
    for (const rule of Array.isArray(raw.ignore) ? raw.ignore : []) {
      if (typeof rule !== 'string' || !rule.trim()) continue;
      if (/[/~]/.test(rule)) ignoreRules.paths.push(expandHome(rule.replace(/\/+$/, '')));
      else ignoreRules.names.add(rule);
    }
  } catch {}
  return ignoreRules;
}

/** Whether the walk should stay out of this folder. */
export function skipDir(path: string, name: string): boolean {
  if (name.startsWith('.') || SKIP_DIRS.has(name)) return true;
  if (name === 'mod' && path.endsWith('/pkg/mod')) return true;
  const rules = ignored();
  return rules.names.has(name) || rules.paths.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Extracts every mermaid diagram from a markdown or .mmd file's text. */
export function extract(file: string, text: string): Diagram[] {
  return parseDoc(file, text).diagrams;
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
export async function findMarkdown(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((e) => {
      const path = join(root, e.name);
      if (e.isDirectory()) return skipDir(path, e.name) ? [] : findMarkdown(path);
      return e.isFile() && /\.(md|mmd)$/.test(e.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

/** `/home/me/x` -> `~/x` */
export function tildePath(path: string): string {
  if (path === homedir()) return '~';
  return path.startsWith(homedir() + '/') ? `~${path.slice(homedir().length)}` : path;
}

/** Path shown to the user: relative to cwd when inside it, else ~-relative. */
export function displayPath(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel.startsWith('..') ? tildePath(file) : rel;
}
