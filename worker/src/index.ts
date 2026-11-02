// trawl docs Worker: serves a `trawl site` build as static assets and a remote MCP server at /mcp, so people
// without trawl installed (product, design) can browse the docs and let their Claude read and change them.
import { parse, render } from 'pele';
import { parseDoc, replaceDiagramSource } from '../../src/markdown.ts';
import { fail, handle, type Json, type McpServer, type Request as RpcRequest, text, type ToolDef, type ToolResult } from '../../src/mcp-protocol.ts';
import type { SiteData, SiteDiagram, SiteDoc } from '../../src/site.ts';

export interface Env {
  ASSETS: { fetch(req: Request | string | URL): Promise<Response> };
  /** Shared secret for /mcp (as /mcp/<key> or `Authorization: Bearer <key>`). Required unless PUBLIC_MCP=true. */
  TRAWL_KEY?: string;
  /** "true" serves a read-only /mcp without a key (public docs only). */
  PUBLIC_MCP?: string;
  /** Fine-grained GitHub token for the docs repo (issues + contents + pull requests: write). Enables the write tools. */
  GITHUB_TOKEN?: string;
  /** owner/name and branch; default from the site's trawl.json. */
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
}

const VERSION = '0.2.0';

let cached: { at: number; data: SiteData } | undefined;
async function siteData(env: Env, origin: string): Promise<SiteData> {
  if (cached && Date.now() - cached.at < 60_000) return cached.data;
  const res = await env.ASSETS.fetch(new URL('/trawl.json', origin));
  if (!res.ok) throw new Error(`trawl.json missing from the site build (HTTP ${res.status})`);
  cached = { at: Date.now(), data: (await res.json()) as SiteData };
  return cached.data;
}

/** `docs/a.md`, `docs/a.md:12`, `docs/a.md#id`; also accepts a full site URL (`…#/doc/docs/a.md/id`). */
function parseRef(ref: string): { path: string; line?: number; anchor?: string } {
  const fromUrl = /#\/doc\/(.+?\.(?:md|mmd))(?:\/(.+))?$/.exec(ref);
  if (fromUrl) return { path: decodeURIComponent(fromUrl[1]), anchor: fromUrl[2] && decodeURIComponent(fromUrl[2]) };
  const m = /^\/?(.*?)(?::(\d+)|#([\w.-]+))?$/.exec(ref.trim())!;
  return { path: m[1], line: m[2] ? Number(m[2]) : undefined, anchor: m[3] };
}

const refSchema = { type: 'string', description: 'Doc path as listed (docs/a.md), with :LINE or #ID (heading slug or diagram id); site links work too' };

const READ_TOOLS: ToolDef[] = [
  {
    name: 'search',
    description: "Search the team's published docs and diagrams. Returns doc path#section, breadcrumb and a snippet per match.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', default: 20 } }, required: ['query'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read',
    description: 'Read a doc section (path#heading-slug or path:LINE) or a whole doc (path) as markdown.',
    inputSchema: { type: 'object', properties: { ref: refSchema }, required: ['ref'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_diagrams',
    description: 'List the Mermaid diagrams as path#id, type and title; optional query filters by words.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_diagram',
    description: "One diagram's Mermaid source, where it lives, whether it parses, and its links (site, GitHub, FigJam).",
    inputSchema: { type: 'object', properties: { ref: refSchema }, required: ['ref'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'render',
    description: 'A published diagram (`ref`) as a PNG image you can look at, or new Mermaid (`source`) as SVG text after a syntax check.',
    inputSchema: { type: 'object', properties: { ref: refSchema, source: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'check',
    description: 'Check Mermaid syntax; errors come with the line.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
    annotations: { readOnlyHint: true },
  },
];

const WRITE_TOOLS: ToolDef[] = [
  {
    name: 'request_change',
    description: 'File a change request for a diagram or doc section as a GitHub issue (labelled trawl) for the docs owners or an agent to pick up. Use when the user describes what should change but not the exact Mermaid.',
    inputSchema: {
      type: 'object',
      properties: { ref: refSchema, request: { type: 'string', description: 'What should change and why, in plain words' } },
      required: ['ref', 'request'],
    },
  },
  {
    name: 'propose_change',
    description: "Open a pull request that replaces one diagram's Mermaid source (checked first). Show the user the render of the new source before calling this. Returns the PR link.",
    inputSchema: {
      type: 'object',
      properties: {
        ref: refSchema,
        source: { type: 'string', description: 'The complete new Mermaid source' },
        summary: { type: 'string', description: 'One or two sentences for the PR: what changed and why' },
      },
      required: ['ref', 'source', 'summary'],
    },
  },
];

function syntaxError(source: string): string | null {
  try {
    parse(source);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const toBase64Utf8 = (s: string) => bytesToBase64(new TextEncoder().encode(s));
const fromBase64Utf8 = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

export class DocsServer implements McpServer {
  readonly name = 'trawl-docs';
  readonly version = VERSION;
  constructor(
    private env: Env,
    private origin: string,
    private data: SiteData,
  ) {}

  get instructions(): string {
    return `Published docs and diagrams of ${this.repo() ?? this.data.name} (${this.data.docs.length} docs, ${this.data.diagrams.length} diagrams), built ${this.data.generatedAt}. Site: ${this.origin}/
- search, read, list_diagrams, get_diagram: find and read docs; refs look like docs/a.md#id.
- render: look at a diagram as an image before describing it.
${this.writable() ? '- To change a diagram: draft new Mermaid, check it, render it and show the user, then propose_change (opens a PR). For vaguer asks, request_change files an issue.' : '- This server is read-only.'}`;
  }

  private repo(): string | undefined {
    return this.env.GITHUB_REPO || this.data.repo?.url.replace('https://github.com/', '');
  }
  private branch(): string {
    return this.env.GITHUB_BRANCH || this.data.repo?.branch || 'main';
  }
  private writable(): boolean {
    return !!(this.env.GITHUB_TOKEN && this.repo());
  }

  tools(): readonly ToolDef[] {
    return this.writable() ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  }

  private doc(path: string): SiteDoc {
    const doc = this.data.docs.find((d) => d.path === path);
    if (!doc) throw new Error(`no doc "${path}"; use search or list_diagrams for paths`);
    return doc;
  }

  private diagram(ref: string): SiteDiagram {
    const r = parseRef(ref);
    const inDoc = this.data.diagrams.filter((d) => d.doc === r.path);
    if (!inDoc.length) throw new Error(`no diagrams in "${r.path}"`);
    if (r.anchor) {
      const d = inDoc.find((x) => x.id === r.anchor);
      if (!d) throw new Error(`no diagram #${r.anchor} in ${r.path} (ids: ${inDoc.map((x) => x.id).join(', ')})`);
      return d;
    }
    if (r.line !== undefined) {
      const d = inDoc.filter((x) => x.line - 1 <= r.line!).at(-1);
      if (d) return d;
    }
    if (inDoc.length === 1) return inDoc[0];
    throw new Error(`${r.path} has ${inDoc.length} diagrams; add #id (${inDoc.map((x) => x.id).join(', ')})`);
  }

  private siteLink(path: string, anchor?: string): string {
    return `${this.origin}/#/doc/${encodeURI(path)}${anchor ? `/${encodeURIComponent(anchor)}` : ''}`;
  }

  private async github(path: string, init: { method?: string; body?: Json } = {}): Promise<Json> {
    const res = await fetch(`https://api.github.com/repos/${this.repo()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'trawl-docs-worker',
        'x-github-api-version': '2022-11-28',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${json.message ?? ''}`.trim());
    return json;
  }

  async call(name: string, args: Json): Promise<ToolResult> {
    try {
      return await this.run(name, args);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  private async run(name: string, args: Json): Promise<ToolResult> {
    switch (name) {
      case 'search': {
        const terms = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const limit = Number(args.limit) || 20;
        const hits: { score: number; line: string }[] = [];
        for (const doc of this.data.docs) {
          for (const s of doc.sections) {
            const head = `${s.crumb} ${doc.title}`.toLowerCase();
            const body = s.text.toLowerCase();
            let score = 0;
            if (!terms.length) score = 1;
            for (const t of terms) {
              if (head.includes(t)) score += 8;
              else if (body.includes(t)) score += 1;
              else if (doc.path.toLowerCase().includes(t)) score += 2;
              else {
                score = -1;
                break;
              }
            }
            if (score > 0) {
              const at = s.anchor ? `${doc.path}#${s.anchor}` : doc.path;
              hits.push({ score, line: `${at}  ${s.level ? s.crumb : doc.title}\n    ${s.text.slice(0, 180) || '(diagram)'}` });
            }
          }
        }
        hits.sort((a, b) => b.score - a.score);
        return text(hits.length ? hits.slice(0, limit).map((h) => h.line).join('\n') : 'No matches.');
      }
      case 'read': {
        const r = parseRef(String(args.ref));
        const doc = this.doc(r.path);
        let sections = doc.sections;
        if (r.anchor) {
          const d = this.data.diagrams.find((x) => x.doc === doc.path && x.id === r.anchor);
          const line = d?.line;
          const s = doc.sections.find((x) => x.anchor === r.anchor) ?? (line ? doc.sections.filter((x) => x.line <= line).at(-1) : undefined);
          if (!s) throw new Error(`${doc.path}: no heading or diagram "${r.anchor}"`);
          sections = [s];
        } else if (r.line !== undefined) {
          sections = [doc.sections.filter((x) => x.line <= r.line!).at(-1) ?? doc.sections[0]];
        }
        const where = sections.length === 1 && sections[0].anchor ? `${doc.path}#${sections[0].anchor}` : doc.path;
        return text(`${where}  (${this.siteLink(doc.path, sections.length === 1 ? sections[0].anchor : undefined)})\n\n${sections.map((s) => s.markdown).join('\n\n')}`);
      }
      case 'list_diagrams': {
        const terms = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const list = this.data.diagrams.filter((d) => terms.every((t) => `${d.key} ${d.title} ${d.type ?? ''}`.toLowerCase().includes(t)));
        return text(list.length ? list.map((d) => `${d.key}\t${d.type ?? '?'}\t${d.title}${d.error ? '\t✗ broken' : ''}`).join('\n') : 'No diagrams found.');
      }
      case 'get_diagram': {
        const d = this.diagram(String(args.ref));
        const links = [
          `site: ${this.siteLink(d.doc, d.id)}`,
          this.repo() ? `github: https://github.com/${this.repo()}/blob/${this.branch()}/${d.doc}#L${d.line}` : '',
          d.figma ? `figjam: ${d.figma}` : '',
        ].filter(Boolean);
        return text(`${d.key}\t${d.type ?? '?'}\t${d.title}\n${d.error ? `does NOT parse: ${d.error}` : 'parses OK'}\n${links.join('\n')}\n\n\`\`\`mermaid\n${d.source}\n\`\`\``);
      }
      case 'render': {
        if (typeof args.source === 'string') {
          const err = syntaxError(args.source);
          if (err) return fail(err);
          return text(render(args.source, { padding: 24 }).svg);
        }
        if (!args.ref) return fail('render needs `ref` or `source`');
        const d = this.diagram(String(args.ref));
        if (d.error || !d.png) return fail(`${d.key} doesn't parse: ${d.error}`);
        const res = await this.env.ASSETS.fetch(new URL(`/${d.png}`, this.origin));
        if (!res.ok) return fail(`render missing from the site build: ${d.png}`);
        return { content: [{ type: 'image', data: bytesToBase64(new Uint8Array(await res.arrayBuffer())), mimeType: 'image/png' }] };
      }
      case 'check': {
        const err = syntaxError(String(args.source ?? ''));
        return err ? fail(err) : text('Parses OK.');
      }
      case 'request_change': {
        if (!this.writable()) return fail('this server is read-only');
        const r = parseRef(String(args.ref));
        const d = this.data.diagrams.find((x) => x.doc === r.path && (!r.anchor || x.id === r.anchor));
        const key = d && (r.anchor || this.data.diagrams.filter((x) => x.doc === r.path).length === 1) ? d.key : `${r.path}${r.anchor ? `#${r.anchor}` : ''}`;
        this.doc(r.path);
        const body = [
          `**${d ? 'Diagram' : 'Doc'}:** \`${key}\` · [view](${this.siteLink(r.path, r.anchor ?? d?.id)})`,
          '',
          '**What should change?**',
          '',
          String(args.request),
          '',
          '_Filed through the trawl docs MCP server._',
          '',
          `<!-- trawl:ref ${key} -->`,
        ].join('\n');
        const issue = await this.github('/issues', { method: 'POST', body: { title: `${d ? 'Diagram' : 'Docs'}: ${d?.title ?? r.path} (${key})`, body, labels: ['trawl'] } });
        return text(`Filed ${issue.html_url}`);
      }
      case 'propose_change': {
        if (!this.writable()) return fail('this server is read-only');
        const source = String(args.source ?? '');
        const err = syntaxError(source);
        if (err) return fail(`Not proposed, the new source doesn't parse:\n${err}`);
        const published = this.diagram(String(args.ref));
        const branch = this.branch();
        const file = (await this.github(`/contents/${encodeURI(published.doc)}?ref=${encodeURIComponent(branch)}`)) as { content: string; sha: string };
        const live = fromBase64Utf8(file.content);
        // Locate the diagram in the file as it is now on the branch (the site can be behind).
        const current = parseDoc(published.doc, live).diagrams.find((x) => x.id === published.id);
        if (!current) return fail(`${published.key} is no longer in ${published.doc} on ${branch}; re-read and retry`);
        if (current.source.trim() === source.trim()) return fail('The new source is the same as the current one.');
        const next = replaceDiagramSource(live, current, source);
        const head = (await this.github(`/git/ref/heads/${encodeURIComponent(branch)}`)) as { object: { sha: string } };
        const newBranch = `trawl/${published.id}-${Date.now().toString(36)}`;
        await this.github('/git/refs', { method: 'POST', body: { ref: `refs/heads/${newBranch}`, sha: head.object.sha } });
        const summary = String(args.summary ?? '').trim() || `Update ${published.title}`;
        await this.github(`/contents/${encodeURI(published.doc)}`, {
          method: 'PUT',
          body: { message: `${published.title}: ${summary}`.slice(0, 200), content: toBase64Utf8(next), sha: file.sha, branch: newBranch },
        });
        const pr = await this.github('/pulls', {
          method: 'POST',
          body: {
            title: `Diagram: ${published.title} (${published.key})`,
            head: newBranch,
            base: branch,
            body: `${summary}\n\nProposed through the trawl docs MCP server. Diagram: [${published.key}](${this.siteLink(published.doc, published.id)})\n\n<!-- trawl:ref ${published.key} -->`,
          },
        });
        return text(`Opened ${pr.html_url}`);
      }
      default:
        return fail(`unknown tool ${name}`);
    }
  }
}

function authorized(req: Request, url: URL, env: Env): boolean | 'unconfigured' {
  if (!env.TRAWL_KEY) return env.PUBLIC_MCP === 'true' ? true : 'unconfigured';
  const fromPath = url.pathname.replace(/^\/mcp\/?/, '');
  const fromHeader = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const given = fromPath || fromHeader;
  if (given.length !== env.TRAWL_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.TRAWL_KEY.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export { authorized };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/mcp' && !url.pathname.startsWith('/mcp/')) return env.ASSETS.fetch(req);

    const auth = authorized(req, url, env);
    if (auth === 'unconfigured') return json({ error: 'set the TRAWL_KEY secret (or PUBLIC_MCP=true for public docs)' }, 503);
    if (!auth) return json({ error: 'unauthorized' }, 401);
    // Streamable HTTP, stateless: every POST carries JSON-RPC and gets a JSON reply; no server-initiated stream.
    if (req.method === 'GET' || req.method === 'DELETE') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    if (req.method !== 'POST') return json({ error: 'POST JSON-RPC to this endpoint' }, 405);

    let body: RpcRequest | RpcRequest[];
    try {
      body = (await req.json()) as RpcRequest | RpcRequest[];
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
    }
    const server = new DocsServer(env, url.origin, await siteData(env, url.origin));
    const messages = Array.isArray(body) ? body : [body];
    const replies = (await Promise.all(messages.map((m) => handle(server, m)))).filter((r) => r !== undefined);
    if (!replies.length) return new Response(null, { status: 202 });
    return json(Array.isArray(body) ? replies : replies[0]);
  },
};
