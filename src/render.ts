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
  // wasm memory isn't garbage collected: without free() every render leaks for the life of the picker.
  const image = resvg.render();
  try {
    return image.asPng();
  } finally {
    image.free();
    resvg.free();
  }
}

/** Rasterizes an SVG at 2x like svgToPng, as raw RGBA pixels (for sixel, which can't take a PNG). */
export async function svgToRgba(svg: string): Promise<{ width: number; height: number; data: Uint8Array }> {
  const fontBuffers = await loadRasterizer();
  const resvg = new Resvg(inlineCssVars(svg), {
    background: '#fff',
    fitTo: { mode: 'zoom', value: 2 },
    font: { fontBuffers, defaultFontFamily: FONT, sansSerifFamily: FONT, loadSystemFonts: false },
  });
  const image = resvg.render();
  try {
    return { width: image.width, height: image.height, data: new Uint8Array(image.pixels) };
  } finally {
    image.free();
    resvg.free();
  }
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
  // No ANSI: its themes assume a light background (labels vanish on dark ones), and escape codes break
  // the picker's truncation and panning. Plain text takes the terminal's own colors.
  return renderMermaidASCII(source.replace(/^\s*---\n[\s\S]*?\n---\n/, ''), {
    colorMode: 'none',
    paddingX: 3,
    paddingY: 2,
  });
}

type Run = { text: string; kind: 'line' | 'arrow' | 'text' };
// Box drawing, the corner glyphs used for some node shapes, and diamonds; then arrowheads.
const LINE_CHARS = /[\u2500-\u257f\u2308-\u230f\u231c-\u231f\u25c6\u25c7]/;
const ARROW_CHARS = /[\u25b2\u25b6\u25b8\u25ba\u25bc\u25c0\u25c2\u25c4\u2190-\u2193]/;

/**
 * Splits a plain ASCII-art line into runs of box lines, arrowheads and label text, so previews can color
 * them themselves (the library's ANSI themes assume a light background and break truncation and panning).
 */
export function colorRuns(line: string): Run[] {
  const runs: Run[] = [];
  for (const ch of line) {
    const kind = ARROW_CHARS.test(ch) ? 'arrow' : LINE_CHARS.test(ch) ? 'line' : 'text';
    const last = runs.at(-1);
    if (last?.kind === kind) last.text += ch;
    else runs.push({ text: ch, kind });
  }
  return runs;
}

/** Cleaned-up box-drawing art for a diagram, or null when beautiful-mermaid can't draw its type. */
export function asciiArt(source: string): string | null {
  try {
    // Subgraph boxes carry a `rect [rgb(...)]` caption from the source's styling: draw it as plain border.
    // HTML in labels (<b>, <br/>) is blanked to spaces of the same width so the boxes stay aligned.
    return toAscii(source)
      .replace(/rect \[rgb\([^)]*\)\]/g, (m) => '─'.repeat(m.length))
      .replace(/<\/?[a-z]+\s*\/?>/gi, (m) => ' '.repeat(m.length));
  } catch {
    return null;
  }
}

/** Art with box lines gray and arrowheads cyan, for plain terminals (fzf previews). */
export function ansiArt(art: string): string {
  const color = { line: '\x1b[90m', arrow: '\x1b[36m', text: '' };
  return art
    .split('\n')
    .map((l) => colorRuns(l).map((r) => (r.kind === 'text' ? r.text : `${color[r.kind]}${r.text}\x1b[0m`)).join(''))
    .join('\n');
}
