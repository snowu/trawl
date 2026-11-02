#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chooseFolders, pickRoots } from './choose.ts';
import { check, diagramAt, formatProblem, renderAll } from './commands.ts';
import { CONFIG_PATH, expandHome, loadConfig, saveConfig } from './config.ts';
import { formatHit, gitRoot, interactiveFind, lookup, searchRoots, showRef } from './find.ts';
import { defaultViewer, openDiagrams, type Viewer } from './open.ts';
import { type Diagram, displayPath, scan, tildePath } from './scan.ts';
import { INDEX_PATH, Store } from './store.ts';
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

  trawl find [QUERY...]            search every doc and section in your folders + this repo (fzf, live)
  trawl find --plain QUERY...      print matches as path:line  section  snippet (for scripts and agents)
  trawl show FILE[:LINE|#ID]       print the section at LINE / with that heading or diagram id, or the file
  trawl index [--rebuild]          update the search index now and print what it holds
  trawl doctor                     what trawl detects: terminal images, cell size, fzf, folders
  trawl mcp                        run as an MCP server on stdio (search, read, diagrams, check, render)

  trawl site [paths...] -o DIR     build a review site of this repo's docs and diagrams (default dir: trawl-site)
  trawl site --serve               build it into a temp folder and open it in the browser
  trawl diff BASE [HEAD]           diagrams added/changed/removed between two git refs (HEAD: working tree)
  trawl diff BASE -o DIR --comment FILE [--image-url URL]
                                   also render before/after PNGs into DIR and write a PR comment to FILE

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
  -i, --in DIR         find: search only this folder (repeatable)
      --plain          find: print results instead of opening fzf
      --limit N        find: at most N results (default 50)
      --prose          find: leave out sections that are only diagrams (the docs view does)
      --repo OWNER/NAME  site: GitHub repo for links and change requests (default: from git remote)
      --branch NAME    site: branch for "View on GitHub" links (default: current)
      --name NAME      site: title (default: the folder name)
      --serve          site: serve the result locally and open the browser
      --comment FILE   diff: write a markdown PR comment to FILE
      --image-url URL  diff: public URL the -o DIR will be served from (used in the comment)
  -h, --help           show this help
  -v, --version        show the version
`;

const COMMANDS = new Set(['doctor', 'open', 'list', 'check', 'render', 'roots', 'find', 'show', 'index', 'mcp', 'site', 'diff']);

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
  process.stderr.write(`Saved ${tildePath(CONFIG_PATH)}:\n`);
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
  await openDiagrams(selected, viewer);
  return 0;
}

async function showCommand(refs: string[], color = false, opts: { preview?: boolean; query?: string } = {}): Promise<number> {
  // fzf runs the preview even with no results, with an empty {1}: show nothing rather than an error.
  if (opts.preview && refs.every((r) => !r.trim())) return 0;
  if (!refs.length) {
    console.error('trawl: show needs FILE[:LINE|#ID]');
    return 2;
  }
  const out = await Promise.all(refs.map((r) => showRef(r, color, opts)));
  console.log(out.join('\n\n'));
  return 0;
}

/** `trawl find`: refresh the index for the scope, then fzf (interactive) or print matches. */
async function findCommand(
  query: string,
  opts: { in?: string[]; plain?: boolean; color?: boolean; prose?: boolean; 'no-refresh'?: boolean; limit?: string },
  viewer: Viewer,
): Promise<number> {
  const roots = opts.in?.length ? opts.in.map((p) => resolve(p)) : await searchRoots();
  const store = new Store();
  try {
    if (!opts['no-refresh']) await store.refresh(roots);
    const interactive = !opts.plain && process.stdin.isTTY && process.stdout.isTTY && Bun.which('fzf');
    if (interactive) {
      store.close();
      return runViews('docs', roots, query, viewer);
    }
    const hits = lookup(store, query, roots, Number(opts.limit) || 50, opts.prose);
    for (const h of hits) console.log(formatHit(h, opts.color));
    return hits.length || !query.trim() ? 0 : 1;
  } finally {
    try {
      store.close();
    } catch {}
  }
}

async function indexCommand(rebuild?: boolean): Promise<number> {
  if (rebuild) await Promise.all(['', '-wal', '-shm'].map((s) => Bun.file(INDEX_PATH + s).delete().catch(() => {})));
  const roots = await searchRoots();
  const store = new Store();
  const started = performance.now();
  const stats = await store.refresh(roots);
  const docs = store.docs(roots).length;
  const diagrams = store.diagrams(roots).length;
  store.close();
  process.stderr.write(
    `${docs} docs, ${diagrams} diagrams in ${roots.map(tildePath).join(', ')}\n` +
      `${stats.updated} files (re)indexed, ${stats.removed} removed in ${Math.round(performance.now() - started)}ms → ${tildePath(INDEX_PATH)}\n`,
  );
  return 0;
}

/** `trawl site`: build the review site; --serve previews it locally. */
async function siteCommand(
  paths: string[],
  opts: { out?: string; repo?: string; branch?: string; name?: string; serve?: boolean },
): Promise<number> {
  const { buildSite, repoInfo, siteRoot } = await import('./site.ts');
  const root = paths.length === 1 && !/\.(md|mmd)$/.test(paths[0]) ? resolve(paths[0]) : siteRoot();
  const out = resolve(opts.out ?? (opts.serve ? join(tmpdir(), `trawl-site-${process.pid}`) : 'trawl-site'));
  const started = performance.now();
  const { data, problems } = await buildSite({
    paths: paths.length ? paths : [root],
    root,
    out,
    name: opts.name,
    repo: repoInfo(root, opts.repo, opts.branch),
  });
  problems.forEach((p) => console.error(p));
  process.stderr.write(
    `${data.docs.length} docs, ${data.diagrams.length} diagrams (${problems.length} broken) → ${tildePath(out)} in ${Math.round(performance.now() - started)}ms\n`,
  );
  if (!opts.serve) return 0;
  const { serveDir } = await import('./serve.ts');
  await serveDir(out);
  return 0;
}

async function diffCommand(
  refs: string[],
  opts: { out?: string; comment?: string; 'image-url'?: string },
): Promise<number> {
  const { diagramDiff, formatChanges, prComment, renderChanges } = await import('./diff.ts');
  const [base, head] = refs;
  if (!base) {
    console.error('trawl: diff needs a BASE git ref (e.g. origin/main)');
    return 2;
  }
  const root = gitRoot();
  if (!root) {
    console.error('trawl: diff needs to run inside a git repo');
    return 2;
  }
  const changes = await diagramDiff(root, base, head);
  console.log(formatChanges(changes));
  if (opts.out) await renderChanges(changes, resolve(opts.out));
  if (opts.comment) await Bun.write(opts.comment, prComment(changes, { imageUrl: opts['image-url'] }));
  return 0;
}

/** Prints what trawl detects about this terminal and setup, for bug reports about images or folders. */
async function doctorCommand(): Promise<number> {
  // The module namespace, not destructured names: cellMeasured is reassigned by detectImages.
  const kitty = await import('./kitty.ts');
  const { getWinsize, setPixelSize } = await import('./tty.ts');
  const before = getWinsize();
  const images = await kitty.detectImages();
  process.stdin.pause();
  const fmt = (w: ReturnType<typeof getWinsize>) => (w ? `${w.cols}x${w.rows} cells, ${w.xpixel}x${w.ypixel} px` : 'unreadable');
  // What fzf will see: write the measured pixel size, read it back now and after a moment (something may reset it).
  let pixelTest = 'skipped (cell size not measured)';
  if (kitty.cellMeasured) {
    const wrote = setPixelSize(kitty.cellPixels);
    const now = getWinsize();
    await Bun.sleep(500);
    const later = getWinsize();
    pixelTest = `${wrote ? 'written' : 'write FAILED'}; reads back ${fmt(now)}, after 0.5s ${fmt(later)}`;
  }
  const fzf = Bun.which('fzf') ? Bun.spawnSync(['fzf', '--version']).stdout.toString().trim() : 'not installed';
  const env = ['TERM', 'TERM_PROGRAM', 'WT_SESSION', 'TMUX', 'TRAWL_IMAGES', 'TRAWL_CELL']
    .map((k) => `${k}=${process.env[k] ?? ''}`)
    .join(' ');
  const { roots, ignore } = await loadConfig();
  console.log(
    [
      `trawl ${pkg.version} on ${process.platform}`,
      `images: ${images || 'none (box art)'}`,
      `cell: ${kitty.cellPixels.width}x${kitty.cellPixels.height} px (${kitty.cellMeasured ? 'measured' : 'guessed: the terminal did not answer CSI 16 t / 14 t'})`,
      `tty winsize: ${fmt(before)}`,
      `pixel size for fzf: ${pixelTest}`,
      `fzf: ${fzf}`,
      `env: ${env}`,
      `folders: ${roots.map(tildePath).join(', ') || 'none'}${ignore?.length ? `; ignoring ${ignore.join(', ')}` : ''}`,
    ].join('\n'),
  );
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: 'boolean', short: 'a' },
      browser: { type: 'boolean', short: 'b' },
      out: { type: 'string', short: 'o' },
      format: { type: 'string', short: 'f', default: 'png' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      in: { type: 'string', short: 'i', multiple: true },
      plain: { type: 'boolean' },
      color: { type: 'boolean' },
      preview: { type: 'boolean' },
      prose: { type: 'boolean' },
      query: { type: 'string' },
      'no-refresh': { type: 'boolean' },
      rebuild: { type: 'boolean' },
      limit: { type: 'string', default: '50' },
      repo: { type: 'string' },
      branch: { type: 'string' },
      name: { type: 'string' },
      serve: { type: 'boolean' },
      comment: { type: 'string' },
      'image-url': { type: 'string' },
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
  if (command === 'doctor') return doctorCommand();
  if (command === 'show') return showCommand(positionals, values.color, { preview: values.preview, query: values.query });
  if (command === 'find') return findCommand(positionals.join(' '), values, viewer);
  if (command === 'index') return indexCommand(values.rebuild);
  if (command === 'site') return siteCommand(positionals, values);
  if (command === 'diff') return diffCommand(positionals, values);
  if (command === 'mcp') {
    const { runMcp } = await import('./mcp.ts');
    await runMcp();
    return 0;
  }

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
      // Bun's console.error paints a TTY red; summaries aren't errors.
      process.stderr.write(`${diagrams.length - problems.length}/${diagrams.length} diagrams OK\n`);
      return problems.length ? 1 : 0;
    }

    case 'render': {
      if (values.format !== 'png' && values.format !== 'svg') {
        console.error(`--format must be png or svg, got ${values.format}`);
        return 2;
      }
      const out = values.out ?? 'trawl-out';
      const problems = await renderAll(diagrams, out, values.format);
      problems.forEach((p) => console.error(formatProblem(p)));
      process.stderr.write(`${diagrams.length - problems.length}/${diagrams.length} diagrams rendered to ${out}\n`);
      return problems.length ? 1 : 0;
    }
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('trawl: the picker needs a terminal; use `trawl list` in pipes');
    return 2;
  }
  return runViews('diagrams', paths, '', viewer, diagrams);
}

/**
 * The two interactive views over the same folders: docs (fzf search) and diagrams (the picker). ctrl-s in either
 * switches to the other, carrying the typed text; the diagrams come from the index the docs view keeps fresh.
 */
async function runViews(start: 'docs' | 'diagrams', scope: string[], query: string, viewer: Viewer, diagrams?: Diagram[]): Promise<number> {
  const { runPicker } = await import('./ui.tsx');
  let view = start;
  let current = diagrams;
  while (true) {
    if (view === 'docs') {
      const r = await interactiveFind(query, scope, viewer);
      if (r.kind === 'quit') return r.code;
      query = r.query;
      view = 'diagrams';
      current = undefined;
      continue;
    }
    if (!current) {
      const store = new Store();
      await store.refresh(scope);
      current = store.diagrams(scope);
      store.close();
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('trawl: the picker needs a terminal; use `trawl list` in pipes');
      return 2;
    }
    const { result, query: typed } = await runPicker(current, scope, viewer, query);
    query = typed;
    if (result === 'quit') return 0;
    if (result === 'docs') {
      view = 'docs';
      continue;
    }
    // ctrl+f / ctrl+a: rescan chosen subfolders (fzf) or every configured folder, then reopen.
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
