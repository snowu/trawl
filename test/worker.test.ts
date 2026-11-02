import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResult } from '../src/mcp-protocol.ts';
import { buildSite, type SiteData } from '../src/site.ts';
import { authorized, DocsServer, type Env } from '../worker/src/index.ts';

const DOC = '# Flows\n\n## Checkout\n\n```mermaid id=checkout\nflowchart LR\n  cart --> pay\n```\n\nText after.\n';
let dir: string;
let data: SiteData;
const realFetch = globalThis.fetch;
const calls: { method: string; url: string; body?: any }[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trawl-worker-'));
  await writeFile(join(dir, 'flows.md'), DOC);
  ({ data } = await buildSite({ paths: [dir], root: dir, out: join(dir, '_site'), repo: { url: 'https://github.com/o/r', branch: 'main' } }));
  // A fake GitHub: the file on main has gained a line since the site was built.
  const live = DOC.replace('Text after.', 'Text after.\n\nNew paragraph.');
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    if (url.includes('/contents/flows.md?ref=main')) return ok({ content: Buffer.from(live).toString('base64'), sha: 'filesha' });
    if (url.endsWith('/git/ref/heads/main')) return ok({ object: { sha: 'headsha' } });
    if (url.endsWith('/git/refs')) return ok({});
    if (url.endsWith('/contents/flows.md') && method === 'PUT') return ok({});
    if (url.endsWith('/pulls')) return ok({ html_url: 'https://github.com/o/r/pull/7' });
    if (url.endsWith('/issues')) return ok({ html_url: 'https://github.com/o/r/issues/8' });
    return new Response('{"message":"nope"}', { status: 404 });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

const env = (extra: Partial<Env> = {}): Env => ({ ASSETS: { fetch: async () => new Response('x') }, ...extra });
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('DocsServer', () => {
  test('read-only without a GitHub token', () => {
    const s = new DocsServer(env(), 'https://docs.example', data);
    expect(s.tools().map((t) => t.name)).not.toContain('propose_change');
    expect(s.instructions).toContain('read-only');
  });

  test('read, get_diagram, and site links as refs', async () => {
    const s = new DocsServer(env(), 'https://docs.example', data);
    expect(textOf(await s.call('read', { ref: 'flows.md#checkout' }))).toContain('## Checkout');
    const d = textOf(await s.call('get_diagram', { ref: 'https://docs.example/#/doc/flows.md/checkout' }));
    expect(d).toContain('cart --> pay');
    expect(d).toContain('github: https://github.com/o/r/blob/main/flows.md#L6');
  });

  test('propose_change edits the live file on a new branch and opens a PR', async () => {
    const s = new DocsServer(env({ GITHUB_TOKEN: 't' }), 'https://docs.example', data);
    expect((await s.call('propose_change', { ref: 'flows.md#checkout', source: 'flowchart LR\n  cart -->', summary: 'x' })).isError).toBe(true);
    calls.length = 0;
    const res = await s.call('propose_change', { ref: 'flows.md#checkout', source: 'flowchart LR\n  cart --> pay --> done', summary: 'Add done step' });
    expect(textOf(res)).toBe('Opened https://github.com/o/r/pull/7');
    const put = calls.find((c) => c.method === 'PUT')!;
    const written = Buffer.from(put.body.content, 'base64').toString();
    expect(written).toContain('cart --> pay --> done');
    expect(written).toContain('New paragraph.'); // the live file, not the published copy
    expect(put.body.sha).toBe('filesha');
    expect(put.body.branch).toStartWith('trawl/checkout-');
    expect(calls.find((c) => c.url.endsWith('/pulls'))!.body.base).toBe('main');
  });

  test('request_change files a labelled issue with the ref marker', async () => {
    const s = new DocsServer(env({ GITHUB_TOKEN: 't' }), 'https://docs.example', data);
    calls.length = 0;
    expect(textOf(await s.call('request_change', { ref: 'flows.md#checkout', request: 'Show failed payments' }))).toContain('issues/8');
    const issue = calls[0].body;
    expect(issue.labels).toEqual(['trawl']);
    expect(issue.body).toContain('<!-- trawl:ref flows.md#checkout -->');
  });
});

test('authorized: key in path or bearer header; unconfigured without a key', () => {
  const req = (path: string, auth?: string) => [new Request(`https://x${path}`, { headers: auth ? { authorization: auth } : {} }), new URL(`https://x${path}`)] as const;
  const e = env({ TRAWL_KEY: 'k3y' });
  expect(authorized(...req('/mcp/k3y'), e)).toBe(true);
  expect(authorized(...req('/mcp', 'Bearer k3y'), e)).toBe(true);
  expect(authorized(...req('/mcp/nope'), e)).toBe(false);
  expect(authorized(...req('/mcp'), env())).toBe('unconfigured');
  expect(authorized(...req('/mcp'), env({ PUBLIC_MCP: 'true' }))).toBe(true);
});
