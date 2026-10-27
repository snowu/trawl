#!/usr/bin/env bun
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { chooseFolders } from './choose.ts';
import { check, diagramAt, formatProblem, renderAll } from './commands.ts';
import { CONFIG_PATH, loadConfig } from './config.ts';
import { defaultViewer, openDiagrams, type Viewer } from './open.ts';
import { type Diagram, displayPath, scan, tildePath } from './scan.ts';
import pkg from '../package.json' with { type: 'json' };

const HELP = `trawl ${pkg.version}: find, preview and open Mermaid diagrams in markdown files

Usage:
  trawl [paths...]                 interactive picker (default path: .)
  trawl open FILE[:LINE]...        open diagrams without the picker (LINE picks the one at that line)
  trawl list [paths...]            print every diagram as path:line  type  title
  trawl check [paths...]           report diagrams with syntax errors (exit 1 if any)
  trawl render [paths...] -o DIR   write every diagram to DIR as PNG (or --format svg)

Paths can be directories (scanned recursively for .md and .mmd) or files.

Options:
  -a, --all            scan every folder listed in ${tildePath(CONFIG_PATH)} instead of paths
  -c, --choose         pick folders to scan with fzf (from the configured folders, else ~)
  -b, --browser        open SVGs in the browser instead of PNGs in feh
  -o, --out DIR        output directory for render (default: ./trawl-out)
  -f, --format FORMAT  png or svg, for render (default: png)
  -h, --help           show this help
  -v, --version        show the version
`;

const COMMANDS = new Set(['open', 'list', 'check', 'render']);

/** Folders to scan: the configured roots (--all), an fzf selection (--choose), or the given paths. */
async function scanPaths(all: boolean | undefined, choose: boolean | undefined, positionals: string[]): Promise<string[]> {
  if (!all && !choose) return positionals.length ? positionals : ['.'];
  const { roots } = await loadConfig();
  if (choose) return chooseFolders(roots.length ? roots : [homedir()]);
  if (!roots.length) throw new Error(`--all needs folders: add {"roots": ["~/code"]} to ${CONFIG_PATH}`);
  return roots;
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
      choose: { type: 'boolean', short: 'c' },
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

  const paths = await scanPaths(values.all, values.choose, positionals);
  if (!paths.length) return 0; // --choose cancelled
  const diagrams = await scan(paths);

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
  if (!diagrams.length) {
    console.error('trawl: no mermaid diagrams found');
    return 1;
  }
  const { runPicker } = await import('./ui.tsx');
  await runPicker(diagrams, viewer);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`trawl: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  },
);
