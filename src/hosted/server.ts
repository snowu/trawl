// `trawl serve`: the review site and a remote MCP server for a docs repo, behind Google sign-in, for running inside a
// private network (AWS: ECS Fargate behind an internal ALB; see deploy/aws). Every request but /healthz and the
// sign-in round trip needs a session (browsers) or a personal MCP token (Claude Code / Desktop), and every MCP call
// is written to the audit log with who made it.
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { handle, type Request as RpcRequest } from '../mcp-protocol.ts';
import type { SiteData } from '../site.ts';
import { inList, loadServeConfig, type ServeConfig } from './config.ts';
import { randomToken, safeEqual, sha256b64url, sign, verify } from './crypto.ts';
import { DocsServer, type GitHubApi, type Role, type User } from './docs.ts';
import { GitHubApp } from './github-app.ts';
import { finishLogin, GOOGLE, type LoginState, type OidcEndpoints, startLogin } from './google.ts';
import { RepoSync } from './sync.ts';
import pkg from '../../package.json' with { type: 'json' };

export interface Site {
  dir: string;
  data: SiteData;
}

export interface ServerDeps {
  config: ServeConfig;
  /** The site being served right now (from the sync, or a prebuilt folder). */
  site: () => Site | undefined;
  github?: GitHubApi;
  oidc?: OidcEndpoints;
  fetchImpl?: typeof fetch;
  log?: (event: Record<string, unknown>) => void;
}

interface Session {
  email: string;
  exp: number;
}

interface McpToken {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

const TOKEN_PREFIX = 'trawl_';
const MCP_BODY_LIMIT = 1024 * 1024;

/** Calls per user per window; writes have their own, smaller budget. */
class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function cookie(name: string, value: string, opts: { maxAge: number; path?: string; secure: boolean }): string {
  return `${name}=${value}; Path=${opts.path ?? '/'}; Max-Age=${opts.maxAge}; HttpOnly; SameSite=Lax${opts.secure ? '; Secure' : ''}`;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** Headers every response gets. Pages add their CSP (with hashes for the site's inline script and style). */
function baseHeaders(secure: boolean): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cache-control': 'no-store',
    ...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

const PAGE_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** A small server-rendered page (sign-in errors, the Connect page): no script, inline styles only. */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · trawl</title><style>
:root{--bg:#fbfaf8;--card:#fff;--text:#1f2421;--muted:#69716c;--line:#e2ded7;--accent:#2f6f62;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#151816;--card:#202522;--text:#e6e9e7;--muted:#97a19b;--line:#2e3531;--accent:#7cc4b2;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 Inter,ui-sans-serif,system-ui,sans-serif}
main{max-width:760px;margin:48px auto;padding:0 16px}h1{font-size:24px;margin:0 0 8px}p{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:18px 0}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
button{font:inherit;background:var(--accent);color:var(--card);border:0;border-radius:8px;padding:8px 16px;cursor:pointer}
a{color:var(--accent)}code{font-family:ui-monospace,Menlo,monospace;font-size:.9em}.warn{color:#a8442f}
</style></head><body><main>${body}</main></body></html>`;
}

/** Adds a "Connect Claude" link to the site and returns it with a CSP allowing exactly its inline script and style. */
async function sitePage(html: string): Promise<{ html: string; csp: string }> {
  const link = '<a class="trawl-connect" href="/connect">Connect Claude</a>';
  const extraCss = '.trawl-connect{position:fixed;right:16px;bottom:16px;z-index:30;background:var(--accent);color:var(--card);padding:6px 12px;border-radius:8px;font-size:13px;text-decoration:none;box-shadow:var(--shadow)}';
  const out = html.replace('</style>', `${extraCss}</style>`).replace('<body>', `<body>\n${link}`);
  const hashes = { script: [] as string[], style: [] as string[] };
  for (const m of out.matchAll(/<(script|style)>([\s\S]*?)<\/\1>/g)) {
    hashes[m[1] as 'script' | 'style'].push(`'sha256-${Buffer.from(await sha256b64url(m[2]), 'base64url').toString('base64')}'`);
  }
  // style-src-attr: the site sets a few style="" attributes; those can't run code.
  const csp = `default-src 'none'; script-src ${hashes.script.join(' ')}; style-src ${hashes.style.join(' ')}; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
  return { html: out, csp };
}

export function createHandler(deps: ServerDeps): (req: Request, ip?: string) => Promise<Response> {
  const { config } = deps;
  const log = deps.log ?? ((e) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e })));
  const secure = !config.insecureDev;
  const base = config.publicUrl.origin;
  const redirectUri = `${base}/auth/callback`;
  const mcpLimiter = new RateLimiter(240, 60_000);
  const writeLimiter = new RateLimiter(20, 3600_000);
  let siteCache: { dir: string; html: string; csp: string } | undefined;

  const respond = (body: BodyInit | null, status: number, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { ...baseHeaders(secure), ...headers } });
  const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
    respond(body, status, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP, ...headers });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    respond(JSON.stringify(body), status, { 'content-type': 'application/json', ...headers });

  const domainAllowed = (email: string) => config.domains.some((d) => email.endsWith(`@${d}`));

  const rolesFor = (email: string): Set<Role> => {
    const roles = new Set<Role>();
    if (inList(email, config.proposers)) roles.add('propose').add('request');
    if (inList(email, config.requesters)) roles.add('request');
    return roles;
  };

  async function session(req: Request): Promise<Session | null> {
    const raw = readCookie(req, 'trawl_session');
    if (!raw) return null;
    const s = await verify<Session>(config.secret, 'session', raw);
    return s && s.exp > Date.now() && domainAllowed(s.email) ? s : null;
  }

  async function mcpUser(req: Request): Promise<User | null> {
    const raw = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!raw) return null;
    const t = await verify<McpToken>(config.secret, 'mcp-token', raw, TOKEN_PREFIX);
    if (!t || t.exp <= Date.now() || t.iat < config.tokensNotBefore || config.revokedTokens.has(t.jti) || !domainAllowed(t.sub)) return null;
    return { email: t.sub, roles: rolesFor(t.sub) };
  }

  async function csrfFor(s: Session): Promise<string> {
    return (await sign(config.secret, 'csrf', { email: s.email, exp: s.exp })).split('.')[1];
  }

  async function serveSite(req: Request, url: URL): Promise<Response> {
    const site = deps.site();
    if (!site) return html(page('Not ready', '<h1>Docs are still loading</h1><p>The first sync from GitHub hasn\'t finished. Try again in a minute.</p>'), 503, { 'retry-after': '30' });
    const path = decodeURIComponent(url.pathname);
    if (path === '/' || path === '/index.html') {
      if (siteCache?.dir !== site.dir) {
        const { html: out, csp } = await sitePage(await Bun.file(join(site.dir, 'index.html')).text());
        siteCache = { dir: site.dir, html: out, csp };
      }
      return respond(siteCache.html, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': siteCache.csp });
    }
    const rel = normalize(path).replace(/^\/+/, '');
    if (rel.startsWith('..') || rel.includes('\0') || !/^(trawl\.json|d\/[\w.-]+|files\/[^?#]+)$/.test(rel)) return respond('not found', 404);
    const file = Bun.file(join(site.dir, rel));
    if (!(await file.exists())) return respond('not found', 404);
    // Diagram renders are content-addressed; cache them privately. Everything else stays no-store.
    return respond(file, 200, { 'content-type': file.type, ...(rel.startsWith('d/') ? { 'cache-control': 'private, max-age=3600' } : {}) });
  }

  async function connectPage(s: Session, issued?: { token: string; exp: number }): Promise<Response> {
    const roles = [...rolesFor(s.email)];
    const mcpUrl = `${base}/mcp`;
    const tokenBlock = issued
      ? `<div class="card"><p class="warn">Copy it now: this token is shown once. It works until ${escapeHtml(new Date(issued.exp).toISOString().slice(0, 10))}.</p>
<p><b>Claude Code</b></p><pre>claude mcp add --transport http trawl-docs ${escapeHtml(mcpUrl)} \\\n  --header "Authorization: Bearer ${escapeHtml(issued.token)}"</pre>
<p><b>Claude Desktop</b> (Settings → Developer → Edit config, then restart)</p><pre>${escapeHtml(JSON.stringify({ mcpServers: { 'trawl-docs': { command: 'npx', args: ['-y', 'mcp-remote@0.15.2', mcpUrl, '--header', `Authorization: Bearer ${issued.token}`] } } }, null, 2))}</pre></div>`
      : '';
    return html(
      page(
        'Connect Claude',
        `<h1>Connect Claude</h1><p>Signed in as <b>${escapeHtml(s.email)}</b>. ${roles.length ? `You can also ${roles.includes('propose') ? 'file change requests and open pull requests' : 'file change requests'}.` : 'You have read access.'}</p>
${tokenBlock}
<div class="card"><p>A personal token lets Claude Code or Claude Desktop search and read these docs, look at diagrams${roles.length ? ' and make the changes you\'re allowed to' : ''}, as you. Every call is logged with your name.</p>
<form method="post" action="/connect"><input type="hidden" name="csrf" value="${escapeHtml(await csrfFor(s))}"><button>${issued ? 'Create another token' : 'Create a token'}</button></form></div>
<p><a href="/">← Back to the docs</a></p>`,
      ),
    );
  }

  return async (req: Request, ip = '') => {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === '/healthz') return json({ ok: true, version: pkg.version, docs: deps.site() ? 'ready' : 'loading' });

      if (path === '/auth/login' && req.method === 'GET') {
        const ret = url.searchParams.get('return') ?? '/';
        const returnTo = ret.startsWith('/') && !ret.startsWith('//') ? ret : '/';
        const { url: to, login } = await startLogin(config.google.clientId, redirectUri, config.domains, returnTo, deps.oidc ?? GOOGLE);
        return respond(null, 302, { location: to, 'set-cookie': cookie('trawl_login', await sign(config.secret, 'login', login), { maxAge: 600, path: '/auth', secure }) });
      }

      if (path === '/auth/callback' && req.method === 'GET') {
        const raw = readCookie(req, 'trawl_login');
        const login = raw ? await verify<LoginState>(config.secret, 'login', raw) : null;
        const state = url.searchParams.get('state') ?? '';
        const code = url.searchParams.get('code') ?? '';
        const clear = cookie('trawl_login', '', { maxAge: 0, path: '/auth', secure });
        if (!login || login.exp < Date.now() || !safeEqual(login.state, state) || !code) {
          log({ kind: 'auth', event: 'denied', reason: 'bad or expired login state', ip });
          return html(page('Sign-in failed', '<h1>Sign-in failed</h1><p>The sign-in link expired or was used already. <a href="/auth/login">Try again</a>.</p>'), 400, { 'set-cookie': clear });
        }
        try {
          const who = await finishLogin({ ...config.google, redirectUri, domains: config.domains }, login, code, deps.oidc ?? GOOGLE, deps.fetchImpl ?? fetch);
          const s: Session = { email: who.email, exp: Date.now() + config.sessionHours * 3600_000 };
          log({ kind: 'auth', event: 'login', user: who.email, ip });
          const headers = new Headers(baseHeaders(secure));
          headers.set('location', login.returnTo);
          headers.append('set-cookie', clear);
          headers.append('set-cookie', cookie('trawl_session', await sign(config.secret, 'session', s), { maxAge: config.sessionHours * 3600, secure }));
          return new Response(null, { status: 302, headers });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          log({ kind: 'auth', event: 'denied', reason, ip });
          return html(page('Sign-in failed', `<h1>Sign-in failed</h1><p>${escapeHtml(reason)}.</p><p>Use your company Google account. <a href="/auth/login">Try again</a>.</p>`), 403, { 'set-cookie': clear });
        }
      }

      if (path === '/auth/logout' && req.method === 'POST') {
        return respond(null, 303, { location: '/', 'set-cookie': cookie('trawl_session', '', { maxAge: 0, secure }) });
      }

      if (path === '/mcp' || path.startsWith('/mcp/')) {
        const user = await mcpUser(req);
        if (!user) {
          log({ kind: 'mcp', event: 'unauthorized', ip });
          return json({ error: 'unauthorized', hint: `create a personal token at ${base}/connect` }, 401, { 'www-authenticate': 'Bearer realm="trawl", error="invalid_token"' });
        }
        if (req.method !== 'POST') return respond(null, 405, { allow: 'POST' });
        if (Number(req.headers.get('content-length') ?? 0) > MCP_BODY_LIMIT) return json({ error: 'request too large' }, 413);
        const raw = await req.text();
        if (raw.length > MCP_BODY_LIMIT) return json({ error: 'request too large' }, 413);
        let body: RpcRequest | RpcRequest[];
        try {
          body = JSON.parse(raw);
        } catch {
          return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
        }
        const messages = (Array.isArray(body) ? body : [body]).slice(0, 20);
        if (!mcpLimiter.allow(user.email)) return json({ error: 'rate limited' }, 429, { 'retry-after': '60' });
        const writes = messages.filter((m) => m.method === 'tools/call' && ['request_change', 'propose_change'].includes(String(m.params?.name))).length;
        for (let i = 0; i < writes; i++) if (!writeLimiter.allow(user.email)) return json({ error: 'write rate limit reached (20 per hour)' }, 429, { 'retry-after': '600' });
        const site = deps.site();
        if (!site) return json({ error: 'docs are still loading' }, 503, { 'retry-after': '30' });
        const server = new DocsServer({
          origin: base,
          data: site.data,
          github: deps.github,
          repo: config.repo?.name,
          branch: config.repo?.branch,
          user,
          asset: async (p) => {
            if (!/^d\/[\w.-]+$/.test(p)) return null;
            const f = Bun.file(join(site.dir, p));
            return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
          },
          audit: (e) => log({ kind: 'audit', ...e, ip }),
        });
        const replies = (await Promise.all(messages.map((m) => handle(server, m)))).filter((r) => r !== undefined);
        if (!replies.length) return respond(null, 202);
        return json(Array.isArray(body) ? replies : replies[0]);
      }

      // Everything else needs a browser session.
      const s = await session(req);
      if (!s) {
        if (req.method === 'GET' && (path === '/' || path === '/connect' || (req.headers.get('accept') ?? '').includes('text/html'))) {
          return respond(null, 302, { location: `/auth/login?return=${encodeURIComponent(path + url.search)}` });
        }
        return json({ error: 'sign in first' }, 401);
      }

      if (path === '/connect') {
        if (req.method === 'GET') return connectPage(s);
        if (req.method === 'POST') {
          // CSRF: same-origin POST only, with the per-session form token.
          const origin = req.headers.get('origin');
          const form = await req.formData().catch(() => null);
          const csrf = String(form?.get('csrf') ?? '');
          if ((origin && origin !== base) || !safeEqual(csrf, await csrfFor(s))) return html(page('Refused', '<h1>Refused</h1><p>That form didn\'t come from this page.</p>'), 403);
          const now = Date.now();
          const t: McpToken = { sub: s.email, iat: now, exp: now + config.tokenDays * 86400_000, jti: randomToken(12) };
          const token = await sign(config.secret, 'mcp-token', t, TOKEN_PREFIX);
          log({ kind: 'auth', event: 'token-issued', user: s.email, jti: t.jti, exp: new Date(t.exp).toISOString(), ip });
          return connectPage(s, { token, exp: t.exp });
        }
        return respond(null, 405, { allow: 'GET, POST' });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return respond(null, 405, { allow: 'GET' });
      return serveSite(req, url);
    } catch (e) {
      log({ kind: 'error', path, error: e instanceof Error ? e.message : String(e) });
      return json({ error: 'internal error' }, 500);
    }
  };
}

/** `trawl serve`: validates config, starts the GitHub sync (or loads a prebuilt site), and listens. */
export async function runServe(env = process.env): Promise<void> {
  const config = loadServeConfig(env);
  const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e }));
  const app = config.githubApp && config.repo ? new GitHubApp(config.githubApp.appId, config.githubApp.privateKey, config.repo.name, config.githubApp.installationId) : undefined;

  let site: () => Site | undefined;
  if (config.repo && app) {
    const sync = new RepoSync(app.api, config.repo, join(env.TMPDIR || tmpdir(), 'trawl-serve'), log);
    void sync.sync();
    setInterval(() => void sync.sync(), config.repo.syncMinutes * 60_000);
    site = () => sync.current;
  } else {
    const dir = config.siteDir!;
    const data = (await Bun.file(join(dir, 'trawl.json')).json()) as SiteData;
    site = () => ({ dir, data });
  }

  const handler = createHandler({ config, site, github: app?.api, log });
  const server = Bun.serve({
    port: config.port,
    hostname: '0.0.0.0',
    maxRequestBodySize: 2 * 1024 * 1024,
    fetch(req, srv) {
      // Behind the ALB the client address is the first X-Forwarded-For entry.
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || srv.requestIP(req)?.address || '';
      return handler(req, ip);
    },
  });
  log({
    kind: 'start',
    version: pkg.version,
    port: server.port,
    url: config.publicUrl.origin,
    docs: config.repo ? `github:${config.repo.name}@${config.repo.branch}` : config.siteDir,
    writes: app ? 'github-app' : 'off',
  });
  const stop = () => {
    log({ kind: 'stop' });
    server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await new Promise(() => {});
}
