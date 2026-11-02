import { resolve } from 'node:path';
import { check, formatProblem } from './commands.ts';
import { searchRoots, lookup } from './find.ts';
import { type Diagram, replaceDiagramSource } from './markdown.ts';
import { findDiagram, findSection, loadDoc, parseRef, sectionText } from './refs.ts';
import { svgToPng, toSvg } from './render.ts';
import { Store } from './store.ts';
import pkg from '../package.json' with { type: 'json' };

import { type Content, fail, handle as handleMessage, type Json, type McpServer, type Request, text, type ToolResult } from './mcp-protocol.ts';

const INSTRUCTIONS = `trawl indexes the user's markdown notes and docs (every configured folder plus the current repo) and the Mermaid diagrams in them.
- search: find docs/sections by words (empty query = recently edited docs). read: get a section or file by ref.
- Refs: /abs/path.md, /abs/path.md:LINE (section or diagram at that line), /abs/path.md#ID (heading slug or diagram id).
- Diagrams: list_diagrams, get_diagram, check, render (returns a PNG you can look at), update_diagram (checks syntax before writing).
- After writing or editing mermaid with your own tools, call check on it; render it to see the layout.`;

const ref = { type: 'string', description: 'File path, optionally with :LINE or #ID (heading slug or diagram id)' };
const paths = {
  type: 'array',
  items: { type: 'string' },
  description: 'Limit to these folders/files (default: all configured folders + the current repo)',
};

export const TOOLS = [
  {
    name: 'search',
    description: "Full-text search over the user's markdown docs (headings weigh most). Returns path:line, section breadcrumb and a snippet per match. Empty query lists recently edited docs.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', default: 20 }, paths }, required: ['query'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read',
    description: 'Read a section (by :LINE or #heading-slug) or a whole markdown/.mmd file.',
    inputSchema: { type: 'object', properties: { ref }, required: ['ref'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_diagrams',
    description: 'List Mermaid diagrams as path#id, type and title. Optional query filters by words in path, title or type.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, paths } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_diagram',
    description: 'Get one diagram\'s Mermaid source, location and whether it parses.',
    inputSchema: { type: 'object', properties: { ref }, required: ['ref'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'check',
    description: 'Check Mermaid syntax: pass `source` (raw mermaid), `ref` (one diagram), or `paths` (every diagram under them). Errors come with line and caret.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, ref, paths } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'render',
    description: 'Render a diagram (by `ref`) or raw Mermaid (`source`) and return it as a PNG image, so you can see the layout. format "svg" returns SVG text instead.',
    inputSchema: {
      type: 'object',
      properties: { ref, source: { type: 'string' }, format: { type: 'string', enum: ['png', 'svg'], default: 'png' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'update_diagram',
    description: "Replace one diagram's Mermaid source in its file (fence, id and surrounding text are kept). Refuses source that doesn't parse. Returns the new render.",
    inputSchema: { type: 'object', properties: { ref, source: { type: 'string' } }, required: ['ref', 'source'] },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
] as const;


function within(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(`${r}/`));
}

function describeDiagram(d: Diagram): string {
  return `${d.file}#${d.id}\t${d.type ?? '?'}\t${d.title}\t(line ${d.line}${d.explicitId ? '' : ', derived id'})`;
}

async function pngContent(source: string): Promise<Content> {
  const png = await svgToPng(toSvg(source));
  return { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' };
}

/** The tool implementations, over one index and one default scope. */
export class Tools implements McpServer {
  readonly name = 'trawl';
  readonly version = pkg.version;
  readonly instructions = INSTRUCTIONS;

  private lastRefresh = 0;
  constructor(
    private store: Store,
    private roots: string[],
    private refreshEveryMs = 5000,
  ) {}

  tools() {
    return TOOLS;
  }

  private async scope(p?: string[]): Promise<string[]> {
    const roots = p?.length ? p.map((x) => resolve(x)) : this.roots;
    if (p?.length || Date.now() - this.lastRefresh > this.refreshEveryMs) {
      await this.store.refresh(roots);
      if (!p?.length) this.lastRefresh = Date.now();
    }
    return roots;
  }

  async call(name: string, args: Json): Promise<ToolResult> {
    try {
      switch (name) {
        case 'search': {
          const roots = await this.scope(args.paths as string[] | undefined);
          const hits = lookup(this.store, String(args.query ?? ''), roots, Number(args.limit) || 20);
          if (!hits.length) return text(`No matches in ${roots.join(', ')}.`);
          return text(
            hits.map((h) => `${h.file}:${h.line}  ${h.level ? h.crumb : h.docTitle}\n    ${h.snippet.replace(/[«»]/g, '**')}`).join('\n'),
          );
        }
        case 'read': {
          const r = parseRef(String(args.ref));
          const doc = await loadDoc(r.file);
          const s = findSection(doc, r);
          if (!s) return text(`${doc.file}  (${doc.title})\n\n${await Bun.file(doc.file).text()}`);
          return text(`${doc.file}:${s.line}  ${s.crumb}\n\n${sectionText(s)}`);
        }
        case 'list_diagrams': {
          const roots = await this.scope(args.paths as string[] | undefined);
          const terms = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
          const list = this.store
            .diagrams(roots)
            .filter((d) => terms.every((t) => `${d.file} ${d.title} ${d.type ?? ''} ${d.id}`.toLowerCase().includes(t)));
          return text(list.length ? list.map(describeDiagram).join('\n') : 'No diagrams found.');
        }
        case 'get_diagram': {
          const r = parseRef(String(args.ref));
          const d = findDiagram(await loadDoc(r.file), r);
          const problems = check([d]);
          const status = problems.length ? `does NOT parse:\n${formatProblem(problems[0])}` : 'parses OK';
          return text(`${describeDiagram(d)}\n${status}\n\n\`\`\`mermaid\n${d.source}\n\`\`\``);
        }
        case 'check': {
          let diagrams: Diagram[];
          if (typeof args.source === 'string') {
            diagrams = [{ file: '<source>', line: 1, title: 'source', type: null, source: args.source, id: 'source', explicitId: false }];
          } else if (args.ref) {
            const r = parseRef(String(args.ref));
            const doc = await loadDoc(r.file);
            diagrams = r.line !== undefined || r.anchor ? [findDiagram(doc, r)] : doc.diagrams;
          } else {
            diagrams = this.store.diagrams(await this.scope(args.paths as string[] | undefined));
          }
          const problems = check(diagrams);
          const summary = `${diagrams.length - problems.length}/${diagrams.length} diagrams OK`;
          return problems.length ? fail(`${problems.map(formatProblem).join('\n')}\n${summary}`) : text(summary);
        }
        case 'render': {
          let source: string;
          if (typeof args.source === 'string') source = args.source;
          else if (args.ref) {
            const r = parseRef(String(args.ref));
            source = findDiagram(await loadDoc(r.file), r).source;
          } else return fail('render needs `ref` or `source`');
          const problems = check([{ file: '<source>', line: 1, title: '', type: null, source, id: '', explicitId: false }]);
          if (problems.length) return fail(formatProblem(problems[0]));
          if (args.format === 'svg') return text(toSvg(source));
          return { content: [await pngContent(source)] };
        }
        case 'update_diagram': {
          const r = parseRef(String(args.ref));
          if (!within(r.file, this.roots)) return fail(`${r.file} is outside trawl's folders (${this.roots.join(', ')}); not writing there`);
          const next = String(args.source ?? '');
          const problems = check([{ file: '<source>', line: 1, title: '', type: null, source: next, id: '', explicitId: false }]);
          if (problems.length) return fail(`Not written, the new source doesn't parse:\n${formatProblem(problems[0])}`);
          const doc = await loadDoc(r.file);
          const d = findDiagram(doc, r);
          await Bun.write(d.file, replaceDiagramSource(await Bun.file(d.file).text(), d, next));
          return { content: [{ type: 'text', text: `Updated ${d.file}#${d.id} (line ${d.line}).` }, await pngContent(next)] };
        }
        default:
          return fail(`unknown tool ${name}`);
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
}

/** Answers one JSON-RPC message; undefined for notifications. */
export function handle(tools: Tools, msg: Request): Promise<Json | undefined> {
  return handleMessage(tools, msg);
}

/** MCP over stdio: one JSON-RPC message per line in, one per line out. Logs go to stderr. */
export async function runMcp(): Promise<void> {
  const tools = new Tools(new Store(), await searchRoots());
  const decoder = new TextDecoder();
  let buffer = '';
  const write = (m: Json) => process.stdout.write(`${JSON.stringify(m)}\n`);
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Request;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      const out = await handle(tools, msg);
      if (out) write(out);
    }
  }
}
