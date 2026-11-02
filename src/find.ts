import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { detectType, parse } from 'pele';
import { loadConfig } from './config.ts';
import { cellMeasured, cellPixels, detectImages } from './kitty.ts';
import { recordedCell, setPixelSize } from './tty.ts';
import type { Doc, Section } from './markdown.ts';
import { ansiArt, asciiArt, svgToRgba, toSvg } from './render.ts';
import { encodeSixel, scaleCrop } from './sixel.ts';
import { renderTermMd } from './term-md.ts';
import { openDiagrams, type Viewer } from './open.ts';
import { findSection, loadDoc, parseRef, sectionText } from './refs.ts';
import { displayPath, tildePath } from './scan.ts';
import { type Hit, Store } from './store.ts';

/** The git repo containing `cwd`, if any. */
export function gitRoot(cwd = process.cwd()): string | undefined {
  const git = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd, stderr: 'ignore' });
  return git.success ? git.stdout.toString().trim() || undefined : undefined;
}

/**
 * Where `find` and the MCP server look by default: every configured folder plus the repo (or folder) you're in,
 * unless that is ~ or / itself.
 */
export async function searchRoots(cwd = process.cwd()): Promise<string[]> {
  const { roots } = await loadConfig();
  const here = gitRoot(cwd) ?? cwd;
  const all = here === homedir() || here === '/' ? roots : [...roots, here];
  // Drop folders already inside another one, so nothing is walked twice.
  const unique = [...new Set(all.map((r) => resolve(r)))];
  return unique.filter((r) => !unique.some((o) => o !== r && r.startsWith(`${o}/`)));
}

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', hit: '\x1b[1;33m', warn: '\x1b[31m', reset: '\x1b[0m' };

/**
 * One result line. Plain (scripts, agents): `path:line<TAB>crumb<TAB>snippet`. For fzf: `path:line<TAB>crumb  dir`,
 * where fzf hides the first field (it only feeds the preview) and the snippet is left to the preview.
 */
export function formatHit(hit: Hit, color = false): string {
  const where = `${displayPath(hit.file)}:${hit.line}`;
  const crumb = hit.level ? hit.crumb : hit.docTitle;
  if (!color) return `${where}\t${crumb}\t${hit.snippet.replace(/[«»]/g, '')}`;
  const doc = hit.level && !hit.crumb.startsWith(hit.docTitle) ? `${hit.docTitle} › ` : '';
  return `${where}\t${ANSI.bold}${doc}${crumb}${ANSI.reset}  ${ANSI.dim}${displayPath(hit.file)}${ANSI.reset}`;
}

/** Search results, or the most recently edited docs for an empty query. */
export function lookup(store: Store, query: string, roots: string[], limit = 50): Hit[] {
  return query.trim() ? store.search(query, { roots, limit }) : store.recent({ roots, limit });
}

const MERMAID_FENCE = /^([ \t]*)(```+|~~~+)[ \t]*mermaid\b[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*$/gm;

/** The reason a diagram doesn't parse, as one line; null when it parses. */
function parseProblem(source: string): string | null {
  try {
    parse(source);
    return null;
  } catch (e) {
    // pele: "Parse error on line N:\n<source line>\n---^\nExpecting ...": keep the line number and the reason.
    const message = e instanceof Error ? e.message : String(e);
    const line = /line (\d+)/.exec(message)?.[1];
    return `doesn't parse${line ? ` (diagram line ${line})` : ''}: ${message.trim().split('\n').at(-1)!.trim()}`;
  }
}

/**
 * One diagram for the terminal: colored box art when it parses, its type has a text renderer and it fits `width`
 * columns; otherwise a note saying why, followed by the source.
 */
export function drawDiagram(source: string, width = Infinity): string {
  // The source as a reminder of what it is, not all of it: the diagram is a ctrl-o away.
  const lines = source.split('\n');
  const shown = lines.length > 8 ? [...lines.slice(0, 6), `… ${lines.length - 6} more lines`] : lines;
  const fenced = `${ANSI.dim}${shown.map((l) => `│ ${l}`).join('\n')}${ANSI.reset}`;
  const problem = parseProblem(source);
  if (problem) return `${ANSI.warn}✗ ${problem}${ANSI.reset}\n${fenced}`;
  const art = asciiArt(source);
  const type = detectType(source) ?? 'diagram';
  if (!art) return `${ANSI.dim}◆ ${type} · no text preview · ctrl-o opens it${ANSI.reset}\n${fenced}`;
  const artWidth = Math.max(...art.split('\n').map((l) => [...l].length));
  if (artWidth > width) return `${ANSI.dim}◆ ${type} · too wide here (${artWidth} cols) · ctrl-/ wider · ctrl-o opens it${ANSI.reset}\n${fenced}`;
  return `${ANSI.dim}◆ ${type} · ctrl-o opens it${ANSI.reset}\n${ansiArt(art.replace(/\s+$/, ''))}`;
}

/** Every Mermaid fence in `markdown` replaced by drawDiagram's output. */
export function drawDiagrams(markdown: string, width = Infinity): string {
  return markdown.replace(MERMAID_FENCE, (_block, _indent, _fence, source: string) => drawDiagram(source, width));
}

/** How the fzf preview can show images: set by interactiveFind from what it asked the terminal. */
interface PreviewImages {
  mode: 'sixel';
  cell: { width: number; height: number };
}

function previewImages(env = process.env): PreviewImages | null {
  const mode = env.TRAWL_PREVIEW_IMAGES;
  const cell = /^(\d+)x(\d+)$/.exec(env.TRAWL_CELL ?? '');
  if (mode !== 'sixel' || !cell) return null;
  // Size by what fzf will assume (it reads the same winsize record), so its line count matches the image.
  return { mode, cell: recordedCell() ?? { width: Number(cell[1]), height: Number(cell[2]) } };
}

/** A diagram as an inline image sized to `cols` x at most `maxRows` cells; null when it doesn't parse. */
async function diagramImage(source: string, img: PreviewImages, cols: number, maxRows: number): Promise<string | null> {
  if (parseProblem(source)) return null;
  const rgba = await svgToRgba(toSvg(source));
  // Fit by pixels: the full width unless that's too tall; never upscale past the 2x render.
  let w = Math.min(cols * img.cell.width, rgba.width);
  let h = Math.round((w * rgba.height) / rgba.width);
  const maxH = maxRows * img.cell.height;
  if (h > maxH) {
    h = maxH;
    w = Math.round((h * rgba.width) / rgba.height);
  }
  return encodeSixel(scaleCrop(rgba, { zoom: 1, x: 0, y: 0 }, Math.max(1, w), Math.max(1, h)));
}

const PREVIEW_MAX_LINES = 120;

/** The section and its subsections (a heading whose text is all in subsections still previews something). */
function sectionWithChildren(doc: Doc, section: Section | undefined): Section[] {
  if (!section) return doc.sections;
  const i = doc.sections.indexOf(section);
  const out = [section];
  for (let j = i + 1; j < doc.sections.length && section.level > 0 && doc.sections[j].level > section.level; j++) out.push(doc.sections[j]);
  return out;
}

/**
 * `trawl show REF`: the section at REF (or the whole file) as markdown, prefixed with where it is. With `preview`
 * (fzf's preview pane): rendered for the terminal, subsections included, query words highlighted, diagrams drawn
 * as images when the terminal can show them, else as box art.
 */
export async function showRef(ref: string, color = false, opts: { preview?: boolean; query?: string } = {}): Promise<string> {
  const r = parseRef(ref);
  const doc = await loadDoc(r.file);
  const section = findSection(doc, r);
  const header = section ? `${displayPath(doc.file)}:${section.line}  ${section.crumb}` : `${displayPath(doc.file)}  ${doc.title}`;
  if (!opts.preview) {
    const body = section ? sectionText(section) : await Bun.file(r.file).text();
    if (!color) return `${header}\n\n${body}`;
    const width = Number(process.env.FZF_PREVIEW_COLUMNS) || process.stdout.columns || Infinity;
    const drawn = doc.file.endsWith('.mmd') ? drawDiagrams(`\`\`\`mermaid\n${body.replace(/\n+$/, '')}\n\`\`\``, width) : drawDiagrams(body, width);
    return `${ANSI.dim}${header}${ANSI.reset}\n\n${drawn}`;
  }

  const width = Number(process.env.FZF_PREVIEW_COLUMNS) || process.stdout.columns || 80;
  const height = Number(process.env.FZF_PREVIEW_LINES) || process.stdout.rows || 40;
  let md = doc.file.endsWith('.mmd')
    ? `\`\`\`mermaid\n${doc.diagrams[0]?.source ?? ''}\n\`\`\``
    : sectionWithChildren(doc, section).map(sectionText).join('\n\n');
  const lines = md.split('\n');
  let more = '';
  if (lines.length > PREVIEW_MAX_LINES) {
    // Don't cut a fence in half: back up to before an unclosed one.
    let cut = PREVIEW_MAX_LINES;
    const fences = lines.slice(0, cut).filter((l) => /^\s*(```|~~~)/.test(l)).length;
    if (fences % 2) cut = lines.slice(0, cut).findLastIndex((l) => /^\s*(```|~~~)/.test(l));
    md = lines.slice(0, cut).join('\n');
    more = `\n\n${ANSI.dim}… ${lines.length - cut} more lines · enter opens the file${ANSI.reset}`;
  }

  const img = previewImages();
  const images = new Map<string, string | null>();
  if (img) {
    for (const m of md.matchAll(MERMAID_FENCE)) {
      if (!images.has(m[3])) images.set(m[3], await diagramImage(m[3], img, width - 1, Math.max(4, Math.min(Math.floor(height * 0.6), height - 10))).catch(() => null));
    }
  }
  const body = renderTermMd(md, {
    query: opts.query,
    diagram: (source) => {
      const image = images.get(source);
      if (!image) return drawDiagram(source, width);
      return `${ANSI.dim}◆ ${detectType(source) ?? 'diagram'} · ctrl-o opens it${ANSI.reset}\n${image}`;
    },
  });
  const where = `${ANSI.dim}${displayPath(doc.file)}:${section?.line ?? 1}${ANSI.reset}`;
  return `${where}\n${body}${more}`;
}

/** How to run this same trawl again from a shell: the compiled binary, or bun + this script. */
function selfCommand(): string {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  return Bun.main.startsWith('/$bunfs') || Bun.main.includes('~BUN') ? q(process.execPath) : `${q(process.execPath)} ${q(Bun.main)}`;
}

/** How the docs view closed: done, or switch to the diagrams view carrying the query. */
export type FindResult = { kind: 'quit'; code: number } | { kind: 'diagrams'; query: string };

/**
 * Interactive search with fzf: results reload as you type (the index answers, no rescans), the preview shows the
 * matching section rendered, enter opens it in $EDITOR at that line, ctrl-o opens the section's diagrams,
 * ctrl-s / alt-m switch to the diagrams view.
 */
export async function interactiveFind(query: string, roots: string[], viewer: Viewer): Promise<FindResult> {
  const self = selfCommand();
  const scope = roots.map((r) => `--in '${r.replaceAll("'", `'\\''`)}'`).join(' ');
  const reload = `${self} find --plain --color --no-refresh ${scope} -- {q} || true`;
  // Ask the terminal now (fzf's preview commands have no terminal to ask) and hand the answer down via env.
  const images = await detectImages();
  // detectImages leaves stdin flowing (the Ink picker needs that); here fzf reads the keyboard, so stop reading it.
  process.stdin.pause();
  const env = { ...process.env } as Record<string, string>;
  // Sixel in fzf's preview only when the cell size is known and fzf can learn the pixel size too (see tty.ts);
  // otherwise box art. Kitty images aren't sized or cleared by fzf's preview, so they get box art as well.
  if (images === 'sixel' && cellMeasured && setPixelSize(cellPixels)) {
    env.TRAWL_PREVIEW_IMAGES = 'sixel';
    env.TRAWL_CELL = `${cellPixels.width}x${cellPixels.height}`;
  } else {
    delete env.TRAWL_PREVIEW_IMAGES;
  }
  const fzf = Bun.spawn(
    [
      'fzf',
      '--ansi',
      '--disabled',
      '--layout',
      'reverse',
      '--query',
      query,
      '--print-query',
      '--delimiter',
      '\t',
      '--with-nth',
      '2..',
      '--prompt',
      'docs › ',
      '--info',
      'inline-right',
      '--header',
      'enter edit · ctrl-o open diagrams · esc quit\nctrl-s diagrams view · ctrl-/ wider · ctrl-y copy',
      '--header-first',
      '--bind',
      `start:reload:${reload}`,
      '--bind',
      `change:reload:${reload}`,
      '--bind',
      `ctrl-y:execute-silent(printf %s {1} | (wl-copy || pbcopy || clip.exe || xclip -selection clipboard) 2>/dev/null)`,
      '--bind',
      'ctrl-/:change-preview-window(right,75%|right,60%)',
      '--expect',
      'ctrl-o,ctrl-s,alt-m',
      '--preview',
      `${self} show --preview --query {q} {1}`,
      '--preview-window',
      'right,60%,wrap,border-left',
      '--preview-label',
      ` ${roots.map(tildePath).join(', ')} `,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', env },
  );
  const out = await new Response(fzf.stdout).text();
  await fzf.exited;
  const [typed = '', key = '', line] = out.split('\n');
  if (key === 'ctrl-s' || key === 'alt-m') return { kind: 'diagrams', query: typed };
  if (!line) return { kind: 'quit', code: 0 };
  const target = line.split('\t')[0];
  const ref = parseRef(target);

  if (key === 'ctrl-o') {
    const doc = await loadDoc(ref.file);
    const section = findSection(doc, ref);
    const next = doc.sections.find((s) => section && s.line > section.line && s.level <= section.level && s.level > 0);
    const inSection = doc.diagrams.filter((d) => !section || (d.line > section.line && (!next || d.line < next.line)));
    const diagrams = inSection.length ? inSection : doc.diagrams;
    if (!diagrams.length) {
      console.error(`trawl: no diagrams in ${displayPath(ref.file)}`);
      return { kind: 'quit', code: 1 };
    }
    await openDiagrams(diagrams, viewer);
    return { kind: 'quit', code: 0 };
  }

  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const [cmd, ...args] = editor.split(/\s+/);
  const proc = Bun.spawn([cmd, ...args, `+${ref.line ?? 1}`, ref.file], { stdio: ['inherit', 'inherit', 'inherit'] });
  return { kind: 'quit', code: await proc.exited };
}
