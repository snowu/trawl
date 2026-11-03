// The docs MCP server over a published `trawl site` build, independent of where it runs: the Cloudflare Worker
// (worker/) and `trawl serve` (AWS and anywhere else) both wrap it. Storage, GitHub access, the signed-in user and
// auditing are passed in, so each host decides how those work.
import { parse, render } from 'pele';
import { parseDoc, replaceDiagramSource } from '../markdown.ts';
import { fail, type Json, type McpServer, text, type ToolDef, type ToolResult } from '../mcp-protocol.ts';
import type { SiteData, SiteDiagram, SiteDoc } from '../site.ts';
import pkg from '../../package.json' with { type: 'json' };

/** What a person may do. Reading is implied by access at all. */
export type Role = 'request' | 'propose';

export interface User {
  email: string;
  roles: ReadonlySet<Role>;
}

/** A GitHub REST call scoped to the docs repo: `path` is relative to /repos/OWNER/NAME. */
export type GitHubApi = (path: string, init?: { method?: string; body?: Json }) => Promise<Json>;

export interface AuditEvent {
  user: string;
  tool: string;
  ref?: string;
  ok: boolean;
  detail?: string;
}

export interface DocsServerOptions {
  /** Base URL of the site, for links. */
  origin: string;
  data: SiteData;
  /** A published file of the site build (d/*.png), or null. */
  asset: (path: string) => Promise<Uint8Array | null>;
  /** Write access to the docs repo; without it the server is read-only. */
  github?: GitHubApi;
  /** owner/name and branch, defaulting to the site build's. */
  repo?: string;
  branch?: string;
  /** Who is calling. Without one (the Worker's shared key) every write tool the server has is allowed. */
  user?: User;
  audit?: (event: AuditEvent) => void;
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

/** Mermaid sources are parsed and laid out on the server: cap their size so one call can't eat the CPU. */
const MAX_SOURCE = 50_000;

/**
 * Text from a caller that goes into an issue or PR body. HTML comments are neutralised so nobody can plant a
 * `<!-- trawl:ref … -->` marker (which automation trusts) or hide text from reviewers.
 */
export function userText(s: string, max: number): string {
  return s.slice(0, max).replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

function syntaxError(source: string): string | null {
  if (source.length > MAX_SOURCE) return `the source is over ${MAX_SOURCE / 1000} KB`;
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
  readonly version = pkg.version;
  private origin: string;
  private data: SiteData;
  constructor(private opts: DocsServerOptions) {
    this.origin = opts.origin;
    this.data = opts.data;
  }

  get instructions(): string {
    return `Published docs and diagrams of ${this.repo() ?? this.data.name} (${this.data.docs.length} docs, ${this.data.diagrams.length} diagrams), built ${this.data.generatedAt}. Site: ${this.origin}/
- search, read, list_diagrams, get_diagram: find and read docs; refs look like docs/a.md#id.
- render: look at a diagram as an image before describing it.
${this.allowed('propose') || this.allowed('request') ? '- To change a diagram: draft new Mermaid, check it, render it and show the user, then propose_change (opens a PR). For vaguer asks, request_change files an issue.' : '- This server is read-only.'}`;
  }

  private repo(): string | undefined {
    return this.opts.repo || this.data.repo?.url.replace('https://github.com/', '');
  }
  private branch(): string {
    return this.opts.branch || this.data.repo?.branch || 'main';
  }
  /** Whether this caller may use a write tool: the server needs GitHub access, the user the role. */
  private allowed(role: Role): boolean {
    if (!this.opts.github || !this.repo()) return false;
    return !this.opts.user || this.opts.user.roles.has(role);
  }

  tools(): readonly ToolDef[] {
    return [
      ...READ_TOOLS,
      ...WRITE_TOOLS.filter((t) => this.allowed(t.name === 'propose_change' ? 'propose' : 'request')),
    ];
  }

  private requestedBy(): string {
    return this.opts.user ? `Requested by ${this.opts.user.email} through the trawl docs MCP server.` : 'Filed through the trawl docs MCP server.';
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

  private github(path: string, init?: { method?: string; body?: Json }): Promise<Json> {
    return this.opts.github!(path, init);
  }

  async call(name: string, args: Json): Promise<ToolResult> {
    let result: ToolResult;
    try {
      result = await this.run(name, args);
    } catch (e) {
      result = fail(e instanceof Error ? e.message : String(e));
    }
    const ref = typeof args.ref === 'string' ? args.ref.slice(0, 300) : undefined;
    const first = result.content[0];
    this.opts.audit?.({
      user: this.opts.user?.email ?? 'shared-key',
      tool: name,
      ref,
      ok: !result.isError,
      detail: result.isError || name === 'request_change' || name === 'propose_change' ? (first?.type === 'text' ? first.text.slice(0, 300) : undefined) : undefined,
    });
    return result;
  }

  private async run(name: string, args: Json): Promise<ToolResult> {
    switch (name) {
      case 'search': {
        const terms = String(args.query ?? '').slice(0, 500).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 20);
        const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 20, 1), 100);
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
        const terms = String(args.query ?? '').slice(0, 500).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 20);
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
        const png = await this.opts.asset(d.png);
        if (!png) return fail(`render missing from the site build: ${d.png}`);
        return { content: [{ type: 'image', data: bytesToBase64(png), mimeType: 'image/png' }] };
      }
      case 'check': {
        const err = syntaxError(String(args.source ?? ''));
        return err ? fail(err) : text('Parses OK.');
      }
      case 'request_change': {
        if (!this.allowed('request')) return fail('not allowed: you need the request role (or the server is read-only)');
        const r = parseRef(String(args.ref));
        const d = this.data.diagrams.find((x) => x.doc === r.path && (!r.anchor || x.id === r.anchor));
        const key = d && (r.anchor || this.data.diagrams.filter((x) => x.doc === r.path).length === 1) ? d.key : `${r.path}${r.anchor ? `#${r.anchor}` : ''}`;
        this.doc(r.path);
        const request = userText(String(args.request ?? ''), 10_000);
        if (!request.trim()) return fail('Not filed: say what should change in `request`.');
        const body = [
          `**${d ? 'Diagram' : 'Doc'}:** \`${key}\` · [view](${this.siteLink(r.path, r.anchor ?? d?.id)})`,
          '',
          '**What should change?**',
          '',
          request,
          '',
          `_${this.requestedBy()}_`,
          '',
          `<!-- trawl:ref ${key} -->`,
        ].join('\n');
        const issue = await this.github('/issues', { method: 'POST', body: { title: `${d ? 'Diagram' : 'Docs'}: ${d?.title ?? r.path} (${key})`, body, labels: ['trawl'] } });
        return text(`Filed ${issue.html_url}`);
      }
      case 'propose_change': {
        if (!this.allowed('propose')) return fail('not allowed: you need the propose role (or the server is read-only)');
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
        const summary = userText(String(args.summary ?? '').trim(), 2000) || `Update ${published.title}`;
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
            body: `${summary}\n\n${this.requestedBy()} Diagram: [${published.key}](${this.siteLink(published.doc, published.id)})\n\n<!-- trawl:ref ${published.key} -->`,
          },
        });
        return text(`Opened ${pr.html_url}`);
      }
      default:
        return fail(`unknown tool ${name}`);
    }
  }
}
