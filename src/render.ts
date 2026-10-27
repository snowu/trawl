import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { renderMermaidASCII } from 'beautiful-mermaid';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { render } from 'pele';
import wasmPath from '@resvg/resvg-wasm/index_bg.wasm' with { type: 'file' };
import interBoldPath from '../fonts/Inter-Bold.ttf' with { type: 'file' };
import interRegularPath from '../fonts/Inter-Regular.ttf' with { type: 'file' };
import pkg from '../package.json' with { type: 'json' };

const FONT = 'Inter';
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'trawl');

/** Renders mermaid source to a standalone SVG with a white background. */
export function toSvg(source: string): string {
  const { svg } = render(source, { padding: 24, fontFamily: `${FONT}, sans-serif` });
  return svg.replace('style="', 'style="background:#fff;');
}

/**
 * resvg ignores CSS custom properties, and pele writes every color as var(--pele-x, #fallback).
 * Inline each var() from the SVG's own `--x:` definitions, falling back to the var's default.
 */
export function inlineCssVars(svg: string): string {
  const defs: Record<string, string> = {};
  for (const m of svg.matchAll(/(--[\w-]+)\s*:\s*([^;"]+)/g)) defs[m[1]] = m[2].trim();
  const resolveVars = (s: string): string => {
    // Vars nest (--_fg: var(--pele-fg, #1f1f1f)), so substitute until none are left.
    for (let i = 0; i < 10 && s.includes('var('); i++) {
      s = s.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name, fallback) =>
        defs[name] ?? fallback ?? '',
      );
    }
    return s;
  };
  for (const k in defs) defs[k] = resolveVars(defs[k]);
  return resolveVars(svg);
}

let fonts: Promise<Uint8Array[]> | undefined;

function loadRasterizer(): Promise<Uint8Array[]> {
  fonts ??= (async () => {
    await initWasm(Bun.file(wasmPath).arrayBuffer());
    return Promise.all([interRegularPath, interBoldPath].map(async (p) => new Uint8Array(await Bun.file(p).arrayBuffer())));
  })();
  return fonts;
}

/** Rasterizes an SVG to PNG at 2x scale using the bundled Inter font. */
export async function svgToPng(svg: string): Promise<Uint8Array> {
  const fontBuffers = await loadRasterizer();
  const resvg = new Resvg(inlineCssVars(svg), {
    background: '#fff',
    fitTo: { mode: 'zoom', value: 2 },
    font: { fontBuffers, defaultFontFamily: FONT, sansSerifFamily: FONT, loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

/** Writes the diagram's SVG or PNG to the cache (keyed by source hash) and returns its path. */
export async function renderToCache(source: string, format: 'svg' | 'png'): Promise<string> {
  const hash = new Bun.CryptoHasher('sha1').update(`${pkg.version}\0${source}`).digest('hex').slice(0, 16);
  const path = join(CACHE_DIR, `${hash}.${format}`);
  if (await Bun.file(path).exists()) return path;

  await mkdir(CACHE_DIR, { recursive: true });
  const svg = toSvg(source);
  await Bun.write(path, format === 'svg' ? svg : await svgToPng(svg));
  return path;
}

/** Terminal (box-drawing) rendering; throws for diagram types beautiful-mermaid doesn't support. */
export function toAscii(source: string): string {
  // beautiful-mermaid rejects YAML frontmatter (---\ntitle: ...\n---).
  return renderMermaidASCII(source.replace(/^\s*---\n[\s\S]*?\n---\n/, ''));
}
