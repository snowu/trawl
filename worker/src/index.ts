// trawl docs Worker: serves a `trawl site` build as static assets and a remote MCP server at /mcp, so people
// without trawl installed (product, design) can browse the docs and let their Claude read and change them.
import { DocsServer, type GitHubApi } from '../../src/hosted/docs.ts';
import { handle, type Json, type Request as RpcRequest } from '../../src/mcp-protocol.ts';
import type { SiteData } from '../../src/site.ts';

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


let cached: { at: number; data: SiteData } | undefined;
async function siteData(env: Env, origin: string): Promise<SiteData> {
  if (cached && Date.now() - cached.at < 60_000) return cached.data;
  const res = await env.ASSETS.fetch(new URL('/trawl.json', origin));
  if (!res.ok) throw new Error(`trawl.json missing from the site build (HTTP ${res.status})`);
  cached = { at: Date.now(), data: (await res.json()) as SiteData };
  return cached.data;
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
    const data = await siteData(env, url.origin);
    const repo = env.GITHUB_REPO || data.repo?.url.replace('https://github.com/', '');
    const github: GitHubApi | undefined =
      env.GITHUB_TOKEN && repo
        ? async (path, init = {}) => {
            const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
              method: init.method ?? 'GET',
              headers: {
                authorization: `Bearer ${env.GITHUB_TOKEN}`,
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
        : undefined;
    const server = new DocsServer({
      origin: url.origin,
      data,
      repo,
      branch: env.GITHUB_BRANCH || undefined,
      github,
      asset: async (path) => {
        const res = await env.ASSETS.fetch(new URL(`/${path}`, url.origin));
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      },
    });
    const messages = Array.isArray(body) ? body : [body];
    const replies = (await Promise.all(messages.map((m) => handle(server, m)))).filter((r) => r !== undefined);
    if (!replies.length) return new Response(null, { status: 202 });
    return json(Array.isArray(body) ? replies : replies[0]);
  },
};
