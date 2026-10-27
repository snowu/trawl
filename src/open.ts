import { renderToCache } from './render.ts';

export type Viewer = 'feh' | 'browser';

/** feh when installed (Linux), else the OS default handler for SVG (usually the browser). */
export function defaultViewer(): Viewer {
  return Bun.which('feh') ? 'feh' : 'browser';
}

function detach(cmd: string[]): void {
  Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'] }).unref();
}

/** Renders the sources and opens them in the viewer without blocking the caller. */
export async function openDiagrams(sources: string[], viewer: Viewer): Promise<void> {
  if (viewer === 'feh') {
    const pngs = await Promise.all(sources.map((s) => renderToCache(s, 'png')));
    detach(['feh', '--scale-down', '--auto-zoom', '--image-bg', 'white', '--title', 'trawl: %u/%l', ...pngs]);
    return;
  }
  const svgs = await Promise.all(sources.map((s) => renderToCache(s, 'svg')));
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  for (const svg of svgs) detach([opener, svg]);
}
