#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chooseFolders, pickRoots } from './choose.ts';
import { check, diagramAt, formatProblem, renderAll } from './commands.ts';
import { CONFIG_PATH, expandHome, loadConfig, saveConfig } from './config.ts';
import { defaultViewer, openDiagrams, type Viewer } from './open.ts';
import { type Diagram, displayPath, scan, tildePath } from './scan.ts';
import pkg from '../package.json' with { type: 'json' };

const HELP = `trawl ${pkg.version}: find, preview and open Mermaid diagrams in markdown files

Usage:
  trawl                            picker over the git repo you're in (else this folder; from ~, your folders)
  trawl --all                      picker over all your configured folders (see \`trawl roots\`)
  trawl PATH...                    picker over these folders/files
                                   in the picker: ctrl+f narrows to subfolders, ctrl+a widens to all folders
  trawl open FILE[:LINE]...        open diagrams without the picker (LINE picks the one at that line)
  trawl list [paths...]            print every diagram as path:line  type  title
  trawl check [paths...]           report diagrams with syntax errors (exit 1 if any)
  trawl render [paths...] -o DIR   write every diagram to DIR as PNG (or --format svg)

  trawl roots                      show the configured folders
  trawl roots pick                 choose them with fzf (anything under ~, or type a path)
  trawl roots add|remove DIR...    add or remove folders

Paths can be directories (scanned recursively for .md and .mmd) or files.
Configured folders live in ${tildePath(CONFIG_PATH)}.

Options:
  -a, --all            scan all configured folders
  -b, --browser        open SVGs in the browser instead of PNGs in feh
  -o, --out DIR        output directory for render (default: ./trawl-out)
  -f, --format FORMAT  png or svg, for render (default: png)
  -h, --help           show this help
  -v, --version        show the version
`;

const COMMANDS = new Set(['open', 'list', 'check', 'render', 'roots']);

/** The git repo containing the current folder, if any. */
function gitRoot(): string | undefined {
  const git = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { stderr: 'ignore' });
  return git.success ? git.stdout.toString().trim() || undefined : undefined;
}

/**
 * Folders to scan, as absolute paths. `--all`: the configured roots. Paths given: those. Otherwise
 * "where I am": the current git repo, else the current folder, except from ~ itself (or /), where
 * scanning everything below would be slow and noisy, so the configured roots are used instead.
 */
export async function scanPaths(all: boolean | undefined, positionals: string[]): Promise<string[]> {
  if (all) return configuredRoots();
  if (positionals.length) return positionals.map((p) => resolve(p));
  const here = gitRoot() ?? process.cwd();
  if (here !== homedir() && here !== '/') return [here];
  const { roots } = await loadConfig();
  return roots.length ? roots : [here];
}

async function configuredRoots(): Promise<string[]> {
  const { roots } = await loadConfig();
  if (!roots.length) throw new Error('no folders configured: run `trawl roots pick` or `trawl roots add DIR`');
  return roots;
}

/** `trawl roots [pick | add DIR... | remove DIR...]` */
async function rootsCommand([action, ...dirs]: string[]): Promise<number> {
  const { roots } = await loadConfig();
  let next: string[];
  switch (action) {
    case undefined:
      if (!roots.length) console.error('No folders configured: run `trawl roots pick` or `trawl roots add DIR`.');
      roots.forEach((r) => console.log(tildePath(r)));
      return 0;
    case 'pick':
      next = await pickRoots();
      if (!next.length) return 0; // cancelled: keep what's there
      break;
    case 'add': {
      const added = dirs.map(expandHome);
      const missing = added.filter((d) => !existsSync(d));
      if (missing.length) {
        console.error(`trawl: not a folder: ${missing.join(', ')}`);
        return 1;
      }
      next = [...roots, ...added];
      break;
    }
    case 'remove': {
      const removed = new Set(dirs.map(expandHome));
      next = roots.filter((r) => !removed.has(r));
      break;
    }
    default:
      console.error(`trawl: unknown roots action "${action}" (expected pick, add or remove)`);
      return 2;
  }
  await saveConfig({ roots: next });
  console.error(`Saved ${tildePath(CONFIG_PATH)}:`);
  next.forEach((r) => console.log(tildePath(r)));
  return 0;
}

/** `trawl open a.md:40 b.mmd`: every diagram in each file, or just the one at LINE. */
async function openCommand(args: string[], viewer: Viewer): Promise<number> {
  const selected: Diagram[] = [];
  for (const arg of args) {
    const [, file, line] = /^(.*?)(?::(\d+))?$/.exec(arg)!;
    const diagrams = await scan([file]);
    const picked = line ? [diagramAt(diagrams, Number(line))].filter((d) => d !== undefined) : diagrams;
    if (!picked.length) {
      console.error(`trawl: no mermaid diagram in ${arg}`);
      return 1;
    }
    selected.push(...picked);
  }
  if (!selected.length) {
    console.error('trawl: open needs at least one FILE[:LINE]');
    return 2;
  }
  await openDiagrams(
    selected.map((d) => d.source),
    viewer,
  );
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: 'boolean', short: 'a' },
      browser: { type: 'boolean', short: 'b' },
      out: { type: 'string', short: 'o', default: 'trawl-out' },
      format: { type: 'string', short: 'f', default: 'png' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help || values.version) {
    process.stdout.write(values.help ? HELP : `${pkg.version}\n`);
    return 0;
  }

  const command = COMMANDS.has(positionals[0]) ? positionals.shift()! : 'pick';
  const viewer: Viewer = values.browser ? 'browser' : defaultViewer();
  if (command === 'open') return openCommand(positionals, viewer);
  if (command === 'roots') return rootsCommand(positionals);

  const paths = await scanPaths(values.all, positionals);
  // Big roots take a moment: show something, then clear the line.
  const showProgress = command === 'pick' && process.stderr.isTTY;
  if (showProgress) process.stderr.write(`trawl: scanning ${paths.map(tildePath).join(', ')}…`);
  const diagrams = await scan(paths);
  if (showProgress) process.stderr.write('\r\x1b[K');

  switch (command) {
    case 'list':
      for (const d of diagrams) console.log(`${displayPath(d.file)}:${d.line}\t${d.type ?? '?'}\t${d.title}`);
      return 0;

    case 'check': {
      const problems = check(diagrams);
      problems.forEach((p) => console.error(formatProblem(p)));
      console.error(`${diagrams.length - problems.length}/${diagrams.length} diagrams OK`);
      return problems.length ? 1 : 0;
    }

    case 'render': {
      if (values.format !== 'png' && values.format !== 'svg') {
        console.error(`--format must be png or svg, got ${values.format}`);
        return 2;
      }
      const problems = await renderAll(diagrams, values.out!, values.format);
      problems.forEach((p) => console.error(formatProblem(p)));
      console.error(`${diagrams.length - problems.length}/${diagrams.length} diagrams rendered to ${values.out}`);
      return problems.length ? 1 : 0;
    }
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('trawl: the picker needs a terminal; use `trawl list` in pipes');
    return 2;
  }
  const { runPicker } = await import('./ui.tsx');
  let current = diagrams;
  // ctrl+f / ctrl+a close the picker to rescan: chosen subfolders (fzf) or every configured folder; then reopen.
  let scope = paths;
  while (true) {
    const result = await runPicker(current, scope, viewer);
    if (result === 'quit') return 0;
    const next = result === 'all' ? (await loadConfig()).roots : await chooseFolders(scope);
    if (!next.length) continue; // fzf cancelled, or no folders configured: back to the same list
    scope = next;
    current = await scan(scope);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`trawl: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  },
);
