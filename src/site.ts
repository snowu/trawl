import { mkdir } from 'node:fs/promises';
import { basename, join, posix, relative, resolve } from 'node:path';
import { Marked, type Tokens } from 'marked';
import { check, formatProblem } from './commands.ts';
import { gitRoot } from './find.ts';
import { type Diagram, type Doc, parseDoc, plainHeading, slug } from './markdown.ts';
import { svgToPng, toSvg } from './render.ts';
import { sectionText } from './refs.ts';
import { findMarkdown } from './scan.ts';
// @ts-expect-error -- the browser app, imported as text (TS can't type a relative .js text import).
import appJs from './site/app.js' with { type: 'text' };
import styleCss from './site/style.css' with { type: 'text' };
import pkg from '../package.json' with { type: 'json' };

export interface RepoInfo {
  /** https://github.com/owner/name */
  url: string;
  branch: string;
}

export interface SiteDiagram {
  /** `docs/a.md#checkout-flow`: the doc's site path and the diagram id. */
  key: string;
  doc: string;
  id: string;
  explicitId: boolean;
  title: string;
  type: string | null;
  line: number;
  source: string;
  svg?: string;
  png?: string;
  /** Syntax error, when the diagram doesn't parse (then there is no svg/png). */
  error?: string;
  figma?: string;
}

export interface SiteSection {
  line: number;
  level: number;
  heading: string;
  crumb: string;
  anchor: string;
  /** Plain text for search (truncated). */
  text: string;
  /** The section as markdown (heading + body), for the remote MCP's `read`. */
  markdown: string;
}

export interface SiteDoc {
  path: string;
  title: string;
  frontmatter: Record<string, string>;
  html: string;
  sections: SiteSection[];
}

export interface SiteData {
  name: string;
  generator: string;
  generatedAt: string;
  repo: RepoInfo | null;
  docs: SiteDoc[];
  diagrams: SiteDiagram[];
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** `git@github.com:o/r.git` / `https://github.com/o/r(.git)` -> `https://github.com/o/r` */
export function githubUrl(remote: string): string | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

function git(cwd: string, ...args: string[]): string | null {
  const r = Bun.spawnSync(['git', ...args], { cwd, stderr: 'ignore' });
  return r.success ? r.stdout.toString().trim() : null;
}

/** GitHub repo and branch of `dir`, unless overridden (`owner/name`, branch). */
export function repoInfo(dir: string, override?: string, branch?: string): RepoInfo | null {
  const url = override ? `https://github.com/${override.replace(/^https:\/\/github\.com\//, '')}` : githubUrl(git(dir, 'remote', 'get-url', 'origin') ?? '');
  if (!url) return null;
  return { url, branch: branch ?? process.env.GITHUB_HEAD_REF ?? git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') ?? 'main' };
}

/** `.trawl/links.json` at the root: `{ "docs/a.md#id": "https://www.figma.com/board/..." }`. */
async function loadLinks(root: string): Promise<Record<string, string>> {
  const f = Bun.file(join(root, '.trawl', 'links.json'));
  if (!(await f.exists())) return {};
  const raw = (await f.json()) as unknown;
  return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
}

/**
 * Markdown -> HTML for one doc. Raw HTML in the markdown is shown as text (the site is shared; docs shouldn't be
 * able to run script in it). Mermaid fences become diagram placeholders the app fills in; links to other docs
 * become in-site links; relative images are collected for copying.
 */
function renderDoc(doc: Doc, raw: string, path: string, keyFor: (d: Diagram) => string, images: Set<string>, docPaths: Set<string>): string {
  const queue = [...doc.diagrams];
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      heading({ tokens, depth, text }: Tokens.Heading) {
        return `<h${depth} id="${slug(plainHeading(text) || text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        if ((lang ?? '').split(/\s/)[0] === 'mermaid') {
          const i = queue.findIndex((d) => d.source.trim() === text.trim());
          const d = i >= 0 ? queue.splice(i, 1)[0] : queue.shift();
          if (d) return `<figure class="diagram" data-key="${escapeHtml(keyFor(d))}"></figure>\n`;
        }
        return `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(text)}</code></pre>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) {
          const target = href.startsWith('#') ? `#/doc/${path}/${href.slice(1)}` : href;
          return `<a href="${escapeHtml(target)}"${t}${href.startsWith('#') ? '' : ' rel="noopener" target="_blank"'}>${inner}</a>`;
        }
        const [file, anchor] = href.split('#');
        const target = posix.normalize(posix.join(posix.dirname(path), decodeURI(file)));
        if (docPaths.has(target)) return `<a href="#/doc/${escapeHtml(target)}${anchor ? `/${escapeHtml(anchor)}` : ''}"${t}>${inner}</a>`;
        return `<a href="${escapeHtml(href)}"${t}>${inner}</a>`;
      },
      image({ href, title, text }: Tokens.Image) {
        let src = href;
        if (!/^[a-z][\w+.-]*:/i.test(href) && !href.startsWith('//')) {
          const target = posix.normalize(posix.join(posix.dirname(path), decodeURI(href.split('#')[0])));
          if (!target.startsWith('..')) {
            images.add(target);
            src = `files/${target}`;
          }
        }
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
      },
    },
  });
  if (doc.file.endsWith('.mmd')) return doc.diagrams[0] ? `<figure class="diagram" data-key="${escapeHtml(keyFor(doc.diagrams[0]))}"></figure>` : '';
  return marked.parse(raw.replace(/^---\n[\s\S]*?\n(---|\.\.\.)\s*\n/, ''), { async: false }) as string;
}

const plain = (md: string) =>
  md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>[\]()|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface BuildOptions {
  /** Folders/files to publish; paths in the site are relative to `root`. */
  paths: string[];
  root: string;
  out: string;
  name?: string;
  repo?: RepoInfo | null;
  /** Also rasterize every diagram to PNG (for PR comments and the remote MCP). Default true. */
  png?: boolean;
}

/** Builds the static review site into `out`: index.html, trawl.json, d/*.svg|png, files/ (images). */
export async function buildSite(opts: BuildOptions): Promise<{ data: SiteData; problems: string[] }> {
  const root = resolve(opts.root);
  const files: string[] = [];
  for (const p of opts.paths.map((x) => resolve(x))) {
    if (/\.(md|mmd)$/.test(p)) files.push(p);
    else files.push(...(await findMarkdown(p)));
  }
  const unique = [...new Set(files)].filter((f) => !relative(root, f).startsWith('..')).sort();
  const docPaths = new Set(unique.map((f) => relative(root, f).split('\\').join('/')));
  const links = await loadLinks(root);
  const images = new Set<string>();
  const docs: SiteDoc[] = [];
  const diagrams: SiteDiagram[] = [];
  const problems: string[] = [];
  await mkdir(join(opts.out, 'd'), { recursive: true });

  for (const file of unique) {
    const path = relative(root, file).split('\\').join('/');
    const raw = await Bun.file(file).text();
    const doc = parseDoc(file, raw);
    const keyFor = (d: Diagram) => `${path}#${d.id}`;

    for (const d of doc.diagrams) {
      const key = keyFor(d);
      const entry: SiteDiagram = {
        key,
        doc: path,
        id: d.id,
        explicitId: d.explicitId,
        title: d.title,
        type: d.type,
        line: d.line,
        source: d.source,
        figma: links[key],
      };
      const problem = check([d])[0];
      if (problem) {
        entry.error = formatProblem({ ...problem, diagram: { ...problem.diagram, file: path } }).replace(/^[^:]+:\d+: /, '');
        problems.push(`${path}:${problem.line}: syntax error, published as broken\n${problem.message.replace(/^/gm, '    ')}`);
      } else {
        const hash = new Bun.CryptoHasher('sha1').update(d.source).digest('hex').slice(0, 12);
        const svg = toSvg(d.source);
        entry.svg = `d/${hash}.svg`;
        await Bun.write(join(opts.out, entry.svg), svg);
        if (opts.png !== false) {
          entry.png = `d/${hash}.png`;
          await Bun.write(join(opts.out, entry.png), await svgToPng(svg));
        }
      }
      diagrams.push(entry);
    }

    docs.push({
      path,
      title: doc.title,
      frontmatter: doc.frontmatter,
      html: renderDoc(doc, raw, path, keyFor, images, docPaths),
      sections: doc.sections.map((s) => ({
        line: s.line,
        level: s.level,
        heading: s.heading,
        crumb: s.crumb,
        anchor: s.level ? slug(s.heading) : '',
        text: plain(s.body).slice(0, 2000),
        markdown: sectionText(s),
      })),
    });
  }

  for (const img of images) {
    const src = Bun.file(join(root, img));
    if (await src.exists()) await Bun.write(join(opts.out, 'files', img), src);
  }

  const data: SiteData = {
    name: opts.name ?? basename(root),
    generator: `trawl ${pkg.version}`,
    generatedAt: new Date().toISOString(),
    repo: opts.repo === undefined ? repoInfo(root) : opts.repo,
    docs,
    diagrams,
  };
  await Bun.write(join(opts.out, 'trawl.json'), JSON.stringify(data));
  await Bun.write(join(opts.out, 'index.html'), indexHtml(data.name));
  return { data, problems };
}

export function indexHtml(name: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} · docs</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232f6f62'/%3E%3Cpath d='M8 10h16M8 16h10M8 22h13' stroke='white' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E">
<style>${styleCss}</style>
</head>
<body>
<div id="app"></div>
<script>${appJs.replaceAll('</script', '<\\/script')}</script>
</body>
</html>
`;
}

/** Default scope for `trawl site`: the repo you're in (or this folder). */
export function siteRoot(cwd = process.cwd()): string {
  return gitRoot(cwd) ?? cwd;
}
