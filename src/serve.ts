import { join, normalize } from 'node:path';

/** Serves a built site folder on localhost, opens it in the browser, and runs until ctrl+c. */
export async function serveDir(dir: string, port = Number(process.env.TRAWL_PORT) || 0): Promise<void> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const rel = normalize(path === '/' ? '/index.html' : path);
      if (rel.includes('..')) return new Response('bad path', { status: 400 });
      const file = Bun.file(join(dir, rel));
      return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  process.stderr.write(`Serving ${url} (ctrl+c to stop)\n`);
  if (!process.env.TRAWL_NO_OPEN) {
    Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url], { stdio: ['ignore', 'ignore', 'ignore'] }).unref();
  }
  await new Promise<void>((resolve) => process.on('SIGINT', () => resolve()));
  server.stop();
}
