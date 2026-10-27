import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
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

/** fzf multi-select over the roots' folders; returns [] when the user cancels. */
export async function chooseFolders(roots: string[]): Promise<string[]> {
  if (!Bun.which('fzf')) throw new Error('--choose needs fzf on your PATH');
  const folders = await listFolders(roots);
  const byLabel = new Map(folders.map((f) => [tildePath(f), f]));

  // fzf draws its UI on /dev/tty itself, so stdin/stdout stay free for the list and the answer.
  const fzf = Bun.spawn(
    ['fzf', '--multi', '--prompt', 'folders> ', '--bind', 'tab:toggle+down',
      '--header', 'tab: select several · enter: scan · esc: cancel'],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );
  fzf.stdin.write([...byLabel.keys()].join('\n'));
  fzf.stdin.end();
  const out = await new Response(fzf.stdout).text();
  await fzf.exited;
  return out.split('\n').filter(Boolean).map((label) => byLabel.get(label) ?? label);
}
