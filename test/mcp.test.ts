import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { handle, Tools, TOOLS } from '../src/mcp.ts';
import { Store } from '../src/store.ts';

let dir: string;
let tools: Tools;
let store: Store;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trawl-mcp-'));
  await cp(resolve(import.meta.dir, '../examples'), dir, { recursive: true });
  store = new Store(':memory:');
  tools = new Tools(store, [dir]);
});
afterAll(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n');

describe('protocol', () => {
  test('initialize echoes a supported protocol version and advertises tools', async () => {
    const res = (await handle(tools, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })) as any;
    expect(res.result.protocolVersion).toBe('2025-03-26');
    expect(res.result.capabilities.tools).toEqual({});
    const unknown = (await handle(tools, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as any;
    expect(unknown.result.protocolVersion).toBe('2025-06-18');
  });

  test('notifications get no reply, unknown methods an error', async () => {
    expect(await handle(tools, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    const res = (await handle(tools, { jsonrpc: '2.0', id: 3, method: 'resources/list' })) as any;
    expect(res.error.code).toBe(-32601);
  });

  test('tools/list', async () => {
    const res = (await handle(tools, { jsonrpc: '2.0', id: 4, method: 'tools/list' })) as any;
    expect(res.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });
});

describe('tools', () => {
  test('search and read', async () => {
    const found = textOf(await tools.call('search', { query: 'refund call' }));
    expect(found).toContain(`${dir}/flows/refunds.md:`);
    const line = /refunds\.md:(\d+)/.exec(found)![1];
    const section = textOf(await tools.call('read', { ref: `${dir}/flows/refunds.md:${line}` }));
    expect(section).toContain('sequenceDiagram');
  });

  test('list_diagrams filters; get_diagram reports broken ones', async () => {
    const list = textOf(await tools.call('list_diagrams', { query: 'broken' }));
    expect(list.split('\n')).toHaveLength(1);
    const ref = list.split('\t')[0];
    expect(textOf(await tools.call('get_diagram', { ref }))).toContain('does NOT parse');
  });

  test('check: source, and a whole tree', async () => {
    expect((await tools.call('check', { source: 'flowchart LR\n  a --> b' })).isError).toBeUndefined();
    const tree = await tools.call('check', {});
    expect(tree.isError).toBe(true);
    expect(textOf(tree)).toMatch(/typo\.md:11/);
  });

  test('render returns a PNG; broken source is an error, not an image', async () => {
    const res = await tools.call('render', { source: 'flowchart LR\n  a --> b' });
    expect(res.content[0].type).toBe('image');
    const png = Buffer.from((res.content[0] as { data: string }).data, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect((await tools.call('render', { source: 'flowchart LR\n  a -->' })).isError).toBe(true);
  });

  test('update_diagram writes valid source, refuses invalid source and files outside its folders', async () => {
    const file = `${dir}/flows/refunds.md`;
    const before = await Bun.file(file).text();
    const bad = await tools.call('update_diagram', { ref: `${file}:5`, source: 'flowchart TD\n  a -->' });
    expect(bad.isError).toBe(true);
    expect(await Bun.file(file).text()).toBe(before);

    const ok = await tools.call('update_diagram', { ref: `${file}:5`, source: 'flowchart TD\n  start --> done' });
    expect(ok.isError).toBeUndefined();
    expect(ok.content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(await Bun.file(file).text()).toContain('```mermaid\nflowchart TD\n  start --> done\n```');

    const outside = await tools.call('update_diagram', { ref: '/etc/x.md', source: 'flowchart TD\n  a --> b' });
    expect(textOf(outside)).toContain('outside');
  });
});
