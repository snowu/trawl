import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPublicKey, generateKeyPairSync, verify as rsaVerify } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inList, loadServeConfig, type ServeConfig } from '../src/hosted/config.ts';
import { b64url, sign, verify } from '../src/hosted/crypto.ts';
import type { GitHubApi } from '../src/hosted/docs.ts';
import { GitHubApp } from '../src/hosted/github-app.ts';
import type { OidcEndpoints } from '../src/hosted/google.ts';
import { createHandler, type Site } from '../src/hosted/server.ts';
import { RepoSync, wanted } from '../src/hosted/sync.ts';
import { buildSite } from '../src/site.ts';

const SECRET = 'x'.repeat(40);
const BASE_ENV = {
  TRAWL_PUBLIC_URL: 'https://trawl.corp.example',
  TRAWL_ALLOWED_DOMAINS: 'corp.example',
  TRAWL_SECRET: SECRET,
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'csecret',
  TRAWL_SITE_DIR: '/srv/site',
};

describe('config', () => {
  test('valid config with defaults', () => {
    const c = loadServeConfig(BASE_ENV);
    expect(c.port).toBe(8080);
    expect(c.sessionHours).toBe(8);
    expect(c.tokenDays).toBe(30);
    expect(c.domains).toEqual(['corp.example']);
  });

  test('every problem is reported at once', () => {
    expect(() => loadServeConfig({ TRAWL_PUBLIC_URL: 'http://trawl.corp.example', TRAWL_SECRET: 'short' })).toThrow(
      /must be https[\s\S]*TRAWL_ALLOWED_DOMAINS is required[\s\S]*at least 32 characters[\s\S]*TRAWL_GITHUB_REPO \(docs synced[\s\S]*GOOGLE_CLIENT_ID is required/,
    );
    expect(() => loadServeConfig({ ...BASE_ENV, TRAWL_SITE_DIR: '', TRAWL_GITHUB_REPO: 'o/r' })).toThrow(/needs GITHUB_APP_ID/);
  });

  test('http only for localhost with TRAWL_INSECURE_DEV', () => {
    expect(loadServeConfig({ ...BASE_ENV, TRAWL_PUBLIC_URL: 'http://localhost:8080', TRAWL_INSECURE_DEV: '1' }).insecureDev).toBe(true);
    expect(() => loadServeConfig({ ...BASE_ENV, TRAWL_PUBLIC_URL: 'http://trawl.corp.example', TRAWL_INSECURE_DEV: '1' })).toThrow(/https/);
  });

  test('role lists: email, @domain, *', () => {
    expect(inList('A@corp.example', ['a@corp.example'])).toBe(true);
    expect(inList('b@corp.example', ['@corp.example'])).toBe(true);
    expect(inList('b@evilcorp.example', ['@corp.example'])).toBe(false);
    expect(inList('z@x', ['*'])).toBe(true);
    expect(inList('z@x', [])).toBe(false);
  });
});

describe('signing', () => {
  test('round-trips; tampering, wrong purpose and wrong secret fail', async () => {
    const v = await sign(SECRET, 'session', { email: 'a@corp.example' });
    expect(await verify(SECRET, 'session', v)).toEqual({ email: 'a@corp.example' });
    expect(await verify(SECRET, 'mcp-token', v)).toBeNull();
    expect(await verify('y'.repeat(40), 'session', v)).toBeNull();
    const [body, mac] = v.split('.');
    const forged = `${b64url(JSON.stringify({ email: 'boss@corp.example' }))}.${mac}`;
    expect(await verify(SECRET, 'session', forged)).toBeNull();
    expect(await verify(SECRET, 'session', `${body}.`)).toBeNull();
  });
});

// ── a fake Google: real RS256 ID tokens, a JWKS, a token endpoint ──────────────────────────────────────────────
let googleKey: CryptoKeyPair;
let jwk: JsonWebKey;
let pendingClaims: Record<string, unknown> = {};
let siteDir: string;
let site: Site;
const OIDC: OidcEndpoints = {
  authorize: 'https://google.test/auth',
  token: 'https://google.test/token',
  jwks: 'https://google.test/jwks',
  issuers: ['https://accounts.google.com'],
};

async function idToken(claims: Record<string, unknown>, key = googleKey.privateKey): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

const fakeGoogle = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === OIDC.jwks) return Response.json({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] });
  if (url === OIDC.token) return Response.json({ id_token: await idToken(pendingClaims) });
  return new Response('nope', { status: 404 });
}) as typeof fetch;

beforeAll(async () => {
  googleKey = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  jwk = await crypto.subtle.exportKey('jwk', googleKey.publicKey);
  siteDir = await mkdtemp(join(tmpdir(), 'trawl-serve-'));
  const { data } = await buildSite({ paths: [resolve(import.meta.dir, '../examples')], root: resolve(import.meta.dir, '../examples'), out: siteDir, repo: { url: 'https://github.com/o/r', branch: 'main' }, png: true });
  site = { dir: siteDir, data };
});
afterAll(() => rm(siteDir, { recursive: true, force: true }));

function app(extra: Partial<Record<string, string>> = {}, github?: GitHubApi) {
  const config: ServeConfig = loadServeConfig({ ...BASE_ENV, ...extra });
  const logs: Record<string, unknown>[] = [];
  const handler = createHandler({ config, site: () => site, github, oidc: OIDC, fetchImpl: fakeGoogle, log: (e) => logs.push(e) });
  const call = (path: string, init: RequestInit = {}) => handler(new Request(`https://trawl.corp.example${path}`, init), '10.0.0.9');
  return { call, logs, config };
}

const cookieValue = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0];

/** Runs the whole Google round trip with these ID-token claims; returns the callback response. */
async function signIn(a: ReturnType<typeof app>, claims: (nonce: string) => Record<string, unknown>) {
  const login = await a.call('/auth/login?return=/connect');
  const to = new URL(login.headers.get('location')!);
  pendingClaims = claims(to.searchParams.get('nonce')!);
  return a.call(`/auth/callback?state=${to.searchParams.get('state')}&code=abc`, { headers: { cookie: cookieValue(login, 'trawl_login')! } });
}

const goodClaims = (nonce: string, extra: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: 'cid',
  exp: Date.now() / 1000 + 600,
  nonce,
  email: 'Alice@corp.example',
  email_verified: true,
  hd: 'corp.example',
  ...extra,
});

describe('sign-in', () => {
  test('anonymous browsers go to sign-in; the login redirect uses PKCE, state, nonce and the domain hint', async () => {
    const a = app();
    const home = await a.call('/', { headers: { accept: 'text/html' } });
    expect(home.status).toBe(302);
    expect(home.headers.get('location')).toBe('/auth/login?return=%2F');
    const login = await a.call('/auth/login');
    const to = new URL(login.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(OIDC.authorize);
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(to.searchParams.get('hd')).toBe('corp.example');
    expect(to.searchParams.get('redirect_uri')).toBe('https://trawl.corp.example/auth/callback');
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax; Secure/);
  });

  test('a good Workspace account gets a session and lands where it was going', async () => {
    const a = app();
    const res = await signIn(a, (n) => goodClaims(n));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/connect');
    expect(cookieValue(res, 'trawl_session')).toBeTruthy();
    expect(a.logs.some((l) => l.event === 'login' && l.user === 'alice@corp.example')).toBe(true);
  });

  test('refused: personal Gmail (no hd), other domain, unverified email, wrong audience, replayed nonce, forged signature', async () => {
    const cases: [string, (n: string) => Record<string, unknown>][] = [
      ['personal account', (n) => goodClaims(n, { hd: undefined, email: 'alice@gmail.com' })],
      ['not in an allowed domain', (n) => goodClaims(n, { hd: 'evil.example' })],
      ['email not verified', (n) => goodClaims(n, { email_verified: false })],
      ['wrong audience', (n) => goodClaims(n, { aud: 'someone-else' })],
      ['nonce mismatch', () => goodClaims('stale')],
      ['expired', (n) => goodClaims(n, { exp: Date.now() / 1000 - 3600 })],
    ];
    for (const [why, claims] of cases) {
      const res = await signIn(app(), claims);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(why);
      expect(cookieValue(res, 'trawl_session')).toBeUndefined();
    }
    const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const a = app();
    const login = await a.call('/auth/login');
    const to = new URL(login.headers.get('location')!);
    const forged = await idToken(goodClaims(to.searchParams.get('nonce')!), other.privateKey);
    const handler = createHandler({ config: a.config, site: () => site, oidc: OIDC, log: () => {}, fetchImpl: (async (u: string | URL | Request) => (String(u) === OIDC.token ? Response.json({ id_token: forged }) : fakeGoogle(u))) as typeof fetch });
    const res = await handler(new Request(`https://trawl.corp.example/auth/callback?state=${to.searchParams.get('state')}&code=x`, { headers: { cookie: cookieValue(login, 'trawl_login')! } }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('bad signature');
  });

  test('callback without the login cookie or with a different state is refused', async () => {
    const a = app();
    expect((await a.call('/auth/callback?state=x&code=y')).status).toBe(400);
    const login = await a.call('/auth/login');
    expect((await a.call('/auth/callback?state=other&code=y', { headers: { cookie: cookieValue(login, 'trawl_login')! } })).status).toBe(400);
  });
});

describe('site, tokens and MCP', () => {
  async function session(a: ReturnType<typeof app>, email = 'alice@corp.example') {
    const res = await signIn(a, (n) => goodClaims(n, { email }));
    return cookieValue(res, 'trawl_session')!;
  }

  async function token(a: ReturnType<typeof app>, cookie: string) {
    const page = await (await a.call('/connect', { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1];
    const res = await a.call('/connect', { method: 'POST', headers: { cookie, origin: 'https://trawl.corp.example', 'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}` });
    return /Bearer (trawl_[\w.-]+)/.exec(await res.text())![1];
  }

  const rpc = (a: ReturnType<typeof app>, tok: string | null, msg: object) =>
    a.call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(msg) });

  test('the site needs a session and gets a strict CSP; paths outside the build are not served', async () => {
    const a = app();
    const cookie = await session(a);
    const home = await a.call('/', { headers: { cookie } });
    expect(home.status).toBe(200);
    const csp = home.headers.get('content-security-policy')!;
    expect(csp).toMatch(/script-src 'sha256-[^']+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src [^;]*unsafe/); // scripts: exactly the site's inline app, by hash
    expect(csp).not.toMatch(/style-src '[^;]*unsafe/); // styles: by hash; only style="" attributes are inline
    expect(home.headers.get('strict-transport-security')).toContain('max-age');
    expect(await home.text()).toContain('href="/connect"');
    expect((await a.call('/trawl.json', { headers: { cookie } })).status).toBe(200);
    expect((await a.call('/trawl.json')).status).toBe(401);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/index.html/../../etc/passwd', '/src/cli.ts']) {
      expect((await a.call(p, { headers: { cookie } })).status).toBe(404);
    }
  });

  test('tokens: CSRF-protected form, shown once with install commands, logged', async () => {
    const a = app();
    const cookie = await session(a);
    const bad = await a.call('/connect', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=nope' });
    expect(bad.status).toBe(403);
    const cross = await a.call('/connect', { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=x' });
    expect(cross.status).toBe(403);
    const tok = await token(a, cookie);
    expect(tok).toStartWith('trawl_');
    expect(a.logs.some((l) => l.event === 'token-issued' && l.user === 'alice@corp.example')).toBe(true);
  });

  test('MCP: no token 401; readers get read tools only; roles from config; calls audited', async () => {
    const a = app({ TRAWL_REQUESTERS: '@corp.example', TRAWL_PROPOSERS: 'bob@corp.example' }, async () => ({}));
    const unauth = await rpc(a, null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain('Bearer');

    const alice = await token(a, await session(a, 'alice@corp.example'));
    const tools = (await (await rpc(a, alice, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as { result: { tools: { name: string }[] } };
    const names = tools.result.tools.map((t) => t.name);
    expect(names).toContain('request_change');
    expect(names).not.toContain('propose_change');

    const bob = await token(a, await session(a, 'bob@corp.example'));
    const bobTools = (await (await rpc(a, bob, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as { result: { tools: { name: string }[] } };
    expect(bobTools.result.tools.map((t) => t.name)).toContain('propose_change');

    const read = (await (await rpc(a, alice, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_diagrams', arguments: { query: 'refund' } } })).json()) as { result: { content: { text: string }[] } };
    expect(read.result.content[0].text).toContain('flows/refunds.md#');
    expect(a.logs.some((l) => l.kind === 'audit' && l.user === 'alice@corp.example' && l.tool === 'list_diagrams' && l.ip === '10.0.0.9')).toBe(true);
  });

  test('MCP: tampered, revoked and pre-cutoff tokens are refused', async () => {
    const a = app();
    const tok = await token(a, await session(a));
    expect((await rpc(a, `${tok}x`, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    const payload = JSON.parse(Buffer.from(tok.slice(6).split('.')[0], 'base64url').toString()) as { jti: string };
    const revoked = app({ TRAWL_REVOKED_TOKENS: payload.jti });
    expect((await rpc(revoked, tok, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    const cutoff = app({ TRAWL_TOKENS_NOT_BEFORE: new Date(Date.now() + 1000).toISOString() });
    expect((await rpc(cutoff, tok, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect((await rpc(app(), tok, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    const otherDomain = app({ TRAWL_ALLOWED_DOMAINS: 'other.example' });
    expect((await rpc(otherDomain, tok, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });

  test('healthz needs no auth and says nothing sensitive', async () => {
    const res = await app().call('/healthz');
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(['docs', 'ok', 'version']);
  });
});

describe('GitHub App', () => {
  test('App JWT is RS256-signed by the App key; installation token is fetched once and reused', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const calls: string[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/repos/o/r/installation')) return Response.json({ id: 42 });
      if (url.endsWith('/app/installations/42/access_tokens')) return Response.json({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (url.endsWith('/repos/o/r/issues')) return Response.json({ html_url: 'https://github.com/o/r/issues/1' });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const gh = new GitHubApp('123', privateKey, 'o/r', undefined, fake);
    const [h, b, s] = gh.appJwt(1_700_000_000).split('.');
    expect(rsaVerify('RSA-SHA256', Buffer.from(`${h}.${b}`), createPublicKey(publicKey), Buffer.from(s, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(b, 'base64url').toString())).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: '123' });
    await gh.api('/issues', { method: 'POST', body: { title: 't' } });
    await gh.api('/issues', { method: 'POST', body: { title: 't' } });
    expect(calls.filter((c) => c.includes('access_tokens'))).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith('/installation'))).toHaveLength(1);
  });

  test('a bad private key fails at startup', () => {
    expect(() => new GitHubApp('1', '-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----', 'o/r')).toThrow();
  });
});

describe('repo sync', () => {
  test('wanted: docs, images and links.json; not dependency folders; path prefixes', () => {
    expect(wanted('docs/a.md', [])).toBe(true);
    expect(wanted('docs/img/x.png', [])).toBe(true);
    expect(wanted('.trawl/links.json', [])).toBe(true);
    expect(wanted('node_modules/x/README.md', [])).toBe(false);
    expect(wanted('src/main.ts', [])).toBe(false);
    expect(wanted('docs/a.md', ['design'])).toBe(false);
    expect(wanted('design/flows/a.md', ['design'])).toBe(true);
  });

  test('builds the site from the tree, only downloads changed blobs, skips unchanged commits', async () => {
    const files: Record<string, string> = {
      'docs/flows.md': '# Flows\n\nText.\n\n```mermaid\nflowchart LR\n  a --> b\n```\n',
      'node_modules/x/README.md': '# skip me',
    };
    let commit = 'c1';
    const blobReads: string[] = [];
    const gh: GitHubApi = async (path) => {
      if (path.startsWith('/git/ref/heads/')) return { object: { sha: commit } };
      if (path.startsWith('/git/trees/')) return { tree: Object.keys(files).map((p) => ({ path: p, type: 'blob', sha: `sha-${p}-${files[p].length}`, size: files[p].length })) };
      const m = /^\/git\/blobs\/sha-(.+)-\d+$/.exec(path);
      if (m) {
        blobReads.push(m[1]);
        return { content: Buffer.from(files[m[1]]).toString('base64'), encoding: 'base64' };
      }
      throw new Error(`unexpected ${path}`);
    };
    const work = await mkdtemp(join(tmpdir(), 'trawl-sync-'));
    const sync = new RepoSync(gh, { name: 'o/r', branch: 'main', paths: [] }, work);
    expect(await sync.sync()).toBe(true);
    expect(sync.current!.data.diagrams.map((d) => d.key)).toEqual(['docs/flows.md#flows']);
    expect(blobReads).toEqual(['docs/flows.md']);
    expect(await sync.sync()).toBe(false); // same commit
    files['docs/new.md'] = '# New\n\nHello.\n';
    commit = 'c2';
    expect(await sync.sync()).toBe(true);
    expect(blobReads).toEqual(['docs/flows.md', 'docs/new.md']); // flows.md reused
    expect(sync.current!.data.docs.map((d) => d.path)).toEqual(['docs/flows.md', 'docs/new.md']);
    await rm(work, { recursive: true, force: true });
  });
});
