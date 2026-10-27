import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from './config.ts';
import { SKIP_DIRS, tildePath } from './scan.ts';

const MAX_DEPTH = 3;

/** Every folder under the roots down to MAX_DEPTH, roots included, skipping dot-dirs and SKIP_DIRS. */
export async function listFolders(roots: string[], maxDepth = MAX_DEPTH): Promise<string[]> {
  const folders: string[] = [];
  const walk = async (dir: string, depth: number) => {
    folders.push(dir);
    if (depth === maxDepth) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), depth + 1);
    }
  };
  for (const root of roots) await walk(root, 0);
  return folders;
}

const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

/**
 * Turns `fzf --multi --print-query` output (typed text, then selected lines) into folder labels.
 * A typed path to an existing folder wins over a single fuzzy match, so paths outside the list
 * (e.g. /tmp/...) work; several tab-selected entries always win, the typed text was then a filter.
 */
export function parseFzfPick(out: string): string[] {
  const [query = '', ...selected] = out.split('\n').filter((line, i) => i === 0 || line);
  if (selected.length <= 1 && /^[/~]/.test(query) && isDir(expandHome(query))) return [query];
  return selected;
}

/** fzf multi-select over the given folders (or a typed path); [] when cancelled. Returns absolute paths. */
async function pickFolders(folders: string[], header: string): Promise<string[]> {
  if (!Bun.which('fzf')) throw new Error('choosing folders needs fzf on your PATH');
  // fzf draws its UI on /dev/tty itself, so stdin/stdout stay free for the list and the answer.
  const fzf = Bun.spawn(
    ['fzf', '--multi', '--print-query', '--prompt', 'folders> ', '--bind', 'tab:toggle+down', '--header', header],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );
  fzf.stdin.write(folders.map(tildePath).join('\n'));
  fzf.stdin.end();
  const out = await new Response(fzf.stdout).text();
  await fzf.exited;
  return parseFzfPick(out).map(expandHome);
}

/** Folders inside the configured roots, for scanning only part of them. */
export async function chooseFolders(roots: string[]): Promise<string[]> {
  return pickFolders(await listFolders(roots), 'scan only these (tab: several · enter: scan · esc: cancel)');
}

/**
 * Any folder under ~ (or a typed path), for setting the configured roots. The current folder's tree comes
 * first, so a clone outside ~ (e.g. /tmp/trawl-test when the installer runs from it) is listed too.
 */
export async function pickRoots(cwd = process.cwd()): Promise<string[]> {
  const home = homedir();
  const here = cwd === home ? [] : await listFolders([cwd]);
  const seen = new Set(here);
  const folders = [...here, ...(await listFolders([home])).filter((f) => !seen.has(f))];
  const picked = await pickFolders(folders, 'folders trawl scans (tab: several · enter: save · or type any path · esc: cancel)');
  return picked.filter(isDir);
}
