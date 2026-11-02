import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { detectType, parse } from 'pele';
import { loadConfig } from './config.ts';
import { ansiArt, asciiArt } from './render.ts';
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

/** `path:line<TAB>crumb<TAB>snippet`; with color, matches are highlighted and the path dimmed. */
export function formatHit(hit: Hit, color = false): string {
  const where = `${displayPath(hit.file)}:${hit.line}`;
  const crumb = hit.level ? hit.crumb : hit.docTitle;
  if (!color) return `${where}\t${crumb}\t${hit.snippet.replace(/[«»]/g, '')}`;
  const snippet = hit.snippet.replaceAll('«', ANSI.hit).replaceAll('»', ANSI.reset);
  return `${ANSI.dim}${where}${ANSI.reset}\t${ANSI.bold}${crumb}${ANSI.reset}\t${snippet}`;
}

/** Search results, or the most recently edited docs for an empty query. */
export function lookup(store: Store, query: string, roots: string[], limit = 50): Hit[] {
  return query.trim() ? store.search(query, { roots, limit }) : store.recent({ roots, limit });
}

const MERMAID_FENCE = /^([ \t]*)(```+|~~~+)[ \t]*mermaid\b[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*$/gm;

/**
 * Mermaid fences drawn as colored box art for the terminal, when the diagram parses, its type has a text
 * renderer, and it fits `width` columns; otherwise the source stays, with a note saying why.
 */
export function drawDiagrams(markdown: string, width = Infinity): string {
  return markdown.replace(MERMAID_FENCE, (block, _indent, _fence, source: string) => {
    try {
      parse(source);
    } catch (e) {
      // pele: "Parse error on line N:\n<source line>\n---^\nExpecting ...": keep the line number and the reason.
      const message = e instanceof Error ? e.message : String(e);
      const line = /line (\d+)/.exec(message)?.[1];
      const reason = message.trim().split('\n').at(-1)!.trim();
      return `${ANSI.warn}✗ doesn't parse${line ? ` (diagram line ${line})` : ''}: ${reason}${ANSI.reset}\n${block}`;
    }
    const art = asciiArt(source);
    const type = detectType(source) ?? 'diagram';
    if (!art) return `${ANSI.dim}◆ ${type}: no text preview for this type · ctrl-o opens it${ANSI.reset}\n${block}`;
    const artWidth = Math.max(...art.split('\n').map((l) => [...l].length));
    if (artWidth > width) return `${ANSI.dim}◆ ${type}: too wide to draw here (${artWidth} cols) · ctrl-/ widens the preview · ctrl-o opens it${ANSI.reset}\n${block}`;
    return `${ANSI.dim}◆ ${type} · ctrl-o opens it${ANSI.reset}\n${ansiArt(art.replace(/\s+$/, ''))}`;
  });
}

/**
 * `trawl show REF`: the section at REF (or the whole file) as markdown, prefixed with where it is. With color
 * (the fzf preview), diagrams are drawn as box art sized to the preview.
 */
export async function showRef(ref: string, color = false): Promise<string> {
  const r = parseRef(ref);
  const doc = await loadDoc(r.file);
  const section = findSection(doc, r);
  const header = section ? `${displayPath(doc.file)}:${section.line}  ${section.crumb}` : `${displayPath(doc.file)}  ${doc.title}`;
  const body = section ? sectionText(section) : await Bun.file(r.file).text();
  if (!color) return `${header}\n\n${body}`;
  const width = Number(process.env.FZF_PREVIEW_COLUMNS) || process.stdout.columns || Infinity;
  const drawn = doc.file.endsWith('.mmd') ? drawDiagrams(`\`\`\`mermaid\n${body.replace(/\n+$/, '')}\n\`\`\``, width) : drawDiagrams(body, width);
  return `${ANSI.dim}${header}${ANSI.reset}\n\n${drawn}`;
}

/** How to run this same trawl again from a shell: the compiled binary, or bun + this script. */
function selfCommand(): string {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  return Bun.main.startsWith('/$bunfs') || Bun.main.includes('~BUN') ? q(process.execPath) : `${q(process.execPath)} ${q(Bun.main)}`;
}

/**
 * Interactive search with fzf: results reload as you type (the index answers, no rescans), the preview shows the
 * matching section, enter opens it in $EDITOR at that line, ctrl-o opens the section's diagrams.
 */
export async function interactiveFind(query: string, roots: string[], viewer: Viewer): Promise<number> {
  const self = selfCommand();
  const scope = roots.map((r) => `--in '${r.replaceAll("'", `'\\''`)}'`).join(' ');
  const reload = `${self} find --plain --color --no-refresh ${scope} -- {q} || true`;
  const fzf = Bun.spawn(
    [
      'fzf',
      '--ansi',
      '--disabled',
      '--query',
      query,
      '--delimiter',
      '\t',
      '--prompt',
      'docs> ',
      '--header',
      `${roots.map(tildePath).join(', ')}\nenter: open in editor · ctrl-o: open its diagrams · ctrl-/: wider preview · ctrl-y: copy path:line · esc: quit`,
      '--bind',
      `start:reload:${reload}`,
      '--bind',
      `change:reload:${reload}`,
      '--bind',
      `ctrl-y:execute-silent(printf %s {1} | (wl-copy || pbcopy || xclip -selection clipboard) 2>/dev/null)`,
      '--bind',
      'ctrl-/:change-preview-window(right,85%|right,55%)',
      '--expect',
      'ctrl-o',
      '--preview',
      `${self} show --color {1}`,
      '--preview-window',
      'right,55%,wrap',
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
  );
  const out = await new Response(fzf.stdout).text();
  await fzf.exited;
  const [key, line] = out.split('\n');
  if (!line) return 0;
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
      return 1;
    }
    await openDiagrams(diagrams, viewer);
    return 0;
  }

  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const [cmd, ...args] = editor.split(/\s+/);
  const proc = Bun.spawn([cmd, ...args, `+${ref.line ?? 1}`, ref.file], { stdio: ['inherit', 'inherit', 'inherit'] });
  return proc.exited;
}
