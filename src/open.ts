import { renderToCache, toSvg } from './render.ts';

export type Viewer = 'feh' | 'browser';

/** feh when installed (Linux), else the browser. */
export function defaultViewer(): Viewer {
  return Bun.which('feh') ? 'feh' : 'browser';
}

function detach(cmd: string[]): void {
  Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'] }).unref();
}

export interface Openable {
  title: string;
  source: string;
}

const BROWSER_WAIT_MS = 15_000;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

/** A page showing one diagram, titled, centered on white. */
export function diagramPage(diagram: Openable): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(diagram.title)} · trawl</title>
<body style="margin:0;padding:24px;background:#fff;display:flex;justify-content:center">${toSvg(diagram.source)}</body>`;
}

/**
 * Opens each diagram in the browser through a one-off localhost server. Not file:// URLs: sandboxed browsers
 * (Ubuntu's snap Firefox, flatpaks) can't read ~/.cache. Resolves once every page was fetched, or after
 * BROWSER_WAIT_MS, then stops the server; the caller's process has to stay alive until then.
 */
async function openInBrowser(diagrams: Openable[]): Promise<void> {
  const pages = diagrams.map(diagramPage);
  const pending = new Set(pages.map((_, i) => `/${i}`));
  let allFetched = () => {};
  const fetched = new Promise<void>((resolve) => (allFetched = resolve));
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const page = pages[Number(path.slice(1))];
      if (page === undefined) return new Response('not found', { status: 404 });
      pending.delete(path);
      if (!pending.size) allFetched();
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  for (let i = 0; i < pages.length; i++) detach([opener, `http://127.0.0.1:${server.port}/${i}`]);
  await Promise.race([fetched, Bun.sleep(BROWSER_WAIT_MS)]);
  // Let the last response finish sending before closing.
  await Bun.sleep(200);
  server.stop();
}

/** Renders the diagrams and opens them in the viewer. */
export async function openDiagrams(diagrams: Openable[], viewer: Viewer): Promise<void> {
  if (viewer === 'browser') return openInBrowser(diagrams);
  const pngs = await Promise.all(diagrams.map((d) => renderToCache(d.source, 'png')));
  detach(['feh', '--scale-down', '--auto-zoom', '--image-bg', 'white', '--title', 'trawl: %u/%l', ...pngs]);
}
