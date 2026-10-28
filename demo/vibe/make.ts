// The "vibe" video: pure motion graphics, no terminal. Every frame is an SVG rasterized by trawl's own
// resvg setup; frames are piped into ffmpeg together with music.wav (see music.py).
//   bun demo/vibe/make.ts            -> demo/trawl-vibe.mp4
//   FPS=30 ONLY=12.5 bun ...         -> just the frame at 12.5s, as demo/build/vibe/frame.png (for checking)
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inlineCssVars, toSvg } from '../../src/render.ts';

const ROOT = join(import.meta.dir, '..', '..');
const BUILD = join(ROOT, 'demo', 'build', 'vibe');
mkdirSync(BUILD, { recursive: true });

const W = 1920;
const H = 1080;
const FPS = Number(process.env.FPS || 60);
const DUR = 23.5;
const BEAT = 0.5; // 120 bpm

const C = {
  bg0: '#090a12', bg1: '#161829', fg: '#c0caf5', dim: '#565f89', blue: '#7aa2f7', purple: '#bb9af7', cyan: '#7dcfff',
  teal: '#2ac3de', green: '#9ece6a', orange: '#ff9e64', red: '#f7768e', yellow: '#e0af68', card: '#1f2335',
};
const MONO = 'JetBrainsMono Nerd Font';
const SANS = 'Inter';

// ── math ──────────────────────────────────────────────────────────────────
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const prog = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const outCubic = (x: number) => 1 - (1 - x) ** 3;
const inCubic = (x: number) => x ** 3;
const inOutCubic = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const outExpo = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
const outBack = (x: number) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
/** 0 -> 1 over [a, a+fadeIn], back to 0 over [b-fadeOut, b]. */
const window_ = (t: number, a: number, b: number, fadeIn = 0.2, fadeOut = 0.2) =>
  Math.min(prog(t, a, a + fadeIn), 1 - prog(t, b - fadeOut, b));
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
/** Decaying pulse on every beat between a and b. */
const beatPulse = (t: number, a: number, b: number) => (t < a || t > b ? 0 : Math.exp(-9 * ((t - a) % BEAT)));

// ── svg helpers ───────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
type TextOpts = { size: number; fill?: string; font?: string; weight?: number; anchor?: string; opacity?: number; extra?: string };
const text = (x: number, y: number, s: string, o: TextOpts) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${o.font ?? SANS}" font-size="${o.size}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? C.fg}" text-anchor="${o.anchor ?? 'start'}" opacity="${(o.opacity ?? 1).toFixed(3)}" ${o.extra ?? ''}>${esc(s)}</text>`;
const g = (inner: string, attrs = '') => `<g ${attrs}>${inner}</g>`;
const scaleAt = (x: number, y: number, s: number) => `translate(${x} ${y}) scale(${s}) translate(${-x} ${-y})`;
/** Monospace advance is 0.6 em, so typed text can stay left-aligned while centered overall. */
const monoWidth = (s: string, size: number) => s.length * size * 0.6;

type Pt = [number, number];
const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, u: number): Pt => {
  const v = 1 - u;
  return [
    v ** 3 * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u ** 3 * p3[0],
    v ** 3 * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u ** 3 * p3[1],
  ];
};
const quad = (p0: Pt, p1: Pt, p2: Pt, u: number): Pt => {
  const v = 1 - u;
  return [v * v * p0[0] + 2 * v * u * p1[0] + u * u * p2[0], v * v * p0[1] + 2 * v * u * p1[1] + u * u * p2[1]];
};

// ── assets ────────────────────────────────────────────────────────────────
const shop = join(ROOT, 'demo', 'shop');
function mermaidBlocks(dir: string): { title: string; source: string }[] {
  const out: { title: string; source: string }[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...mermaidBlocks(p));
    else if (name.endsWith('.mmd')) out.push({ title: name.replace('.mmd', ''), source: readFileSync(p, 'utf8') });
    else if (name.endsWith('.md')) {
      let heading = name;
      for (const part of readFileSync(p, 'utf8').split(/^```/m)) {
        if (part.startsWith('mermaid')) out.push({ title: heading, source: part.slice('mermaid'.length) });
        const h = [...part.matchAll(/^#+ (.+)$/gm)].pop();
        if (h) heading = h[1];
      }
    }
  }
  return out;
}

await initWasm(Bun.file(join(ROOT, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')).arrayBuffer());
const fontFiles = [
  join(ROOT, 'fonts/Inter-Regular.ttf'),
  join(ROOT, 'fonts/Inter-Bold.ttf'),
  '/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf',
  '/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Bold.ttf',
].filter(existsSync);
const fontBuffers = fontFiles.map((p) => new Uint8Array(readFileSync(p)));
const font = { fontBuffers, defaultFontFamily: SANS, sansSerifFamily: SANS, monospaceFamily: MONO, loadSystemFonts: false };

const TILE_TITLES = [
  'Platform overview', 'Checkout', 'Tables', 'Domain classes', 'Ideas', 'Weekly sales',
  'order-lifecycle', 'Refund decision', 'Pipeline', 'Branching', 'Q1 plan', 'Where orders come from',
];
const blocks = mermaidBlocks(shop);
const tiles = TILE_TITLES.map((title) => {
  const b = blocks.find((x) => x.title === title);
  if (!b) throw new Error(`no diagram titled ${title}`);
  const png = new Resvg(inlineCssVars(toSvg(b.source)), { background: '#fff', fitTo: { mode: 'width', value: 720 }, font })
    .render()
    .asPng();
  return { title, href: `data:image/png;base64,${Buffer.from(png).toString('base64')}` };
});

// ── scene data ────────────────────────────────────────────────────────────
const FRAGMENTS = [
  '```mermaid', 'flowchart LR', 'A --> B', 'sequenceDiagram', 'Alice->>Bob: hi', 'erDiagram', 'gantt', 'pie',
  'stateDiagram-v2', 'classDef hot fill:#f7768e', 'subgraph edge', 'gitGraph', 'mindmap', 'journey', 'B -->|yes| C',
  'participant API', 'loop retry', '[*] --> Draft', 'ORDER ||--o{ ITEM', 'commit id: "v2"', 'quadrantChart', 'timeline',
  'actor Shopper', 'xychart-beta', 'note over A,B', 'Orders --> Kafka', 'checkout --> pay', 'end', 'alt declined',
  '```', 'graph TD', 'C{decide?}', 'section Q1', 'rect rgb(30,58,138)',
];
const r1 = rng(7);
const frags = FRAGMENTS.map((s, i) => ({
  s,
  x0: lerp(-150, W - 100, r1()),
  y: lerp(90, H - 90, (i + r1()) / FRAGMENTS.length),
  size: Math.round(lerp(18, 34, r1())),
  vx: lerp(14, 40, r1()),
  bob: r1() * 6,
  op: lerp(0.25, 0.65, r1()),
  color: [C.dim, C.blue, C.purple, C.cyan, C.dim, C.fg][Math.floor(r1() * 6)],
  caught: -1,
  cx: 0,
  cy: 0,
}));
const r2 = rng(11);
const bubbles = Array.from({ length: 70 }, () => ({
  x: r2() * W, y0: r2() * H, r: lerp(1.5, 6, r2()), v: lerp(18, 70, r2()), ph: r2() * 6, op: lerp(0.12, 0.4, r2()),
}));

// ── layers ────────────────────────────────────────────────────────────────
function background(t: number) {
  const pulse = beatPulse(t, 5, 15) * 0.5 + beatPulse(t, 19.5, 23) * 0.2;
  const ax = 380 + 140 * Math.sin(t * 0.35);
  const bx = 1560 + 120 * Math.cos(t * 0.3);
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg0}"/></linearGradient>
    <radialGradient id="ga"><stop offset="0" stop-color="${C.blue}" stop-opacity="${0.22 + pulse * 0.25}"/><stop offset="1" stop-color="${C.blue}" stop-opacity="0"/></radialGradient>
    <radialGradient id="gb"><stop offset="0" stop-color="${C.purple}" stop-opacity="${0.18 + pulse * 0.2}"/><stop offset="1" stop-color="${C.purple}" stop-opacity="0"/></radialGradient>
    <linearGradient id="logo" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.cyan}"/><stop offset="0.5" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.purple}"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="${ax}" cy="230" r="720" fill="url(#ga)"/>
  <circle cx="${bx}" cy="900" r="760" fill="url(#gb)"/>`;
}

function bubbleLayer(t: number, op: number) {
  if (op <= 0) return '';
  return g(
    bubbles
      .map((b) => {
        const y = H + 20 - ((H + 40 - b.y0 + t * b.v) % (H + 40));
        const x = b.x + 10 * Math.sin(t * 1.3 + b.ph);
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${b.r}" fill="none" stroke="${C.cyan}" stroke-width="1.4" opacity="${b.op}"/>`;
      })
      .join(''),
    `opacity="${op.toFixed(3)}"`,
  );
}

// The net's rim sweeps left to right; its mesh trails back to a cod-end behind it.
const netX = (t: number) => lerp(-250, W + 1150, inOutCubic(prog(t, 5, 8.1)));
const RIM_N = 15;
function rimPoint(x: number, k: number, t: number): Pt {
  const y = 80 + (k * (H - 160)) / (RIM_N - 1);
  const edge = (y - H / 2) / (H / 2 - 80);
  return [x - 110 * edge * edge + 26 * Math.sin(k * 0.8 + t * 5), y];
}
function rimXAt(x: number, y: number, t: number) {
  const k = clamp(((y - 80) / (H - 160)) * (RIM_N - 1), 0, RIM_N - 1);
  return rimPoint(x, Math.round(k), t)[0];
}
function net(x: number, t: number, op: number, tail: Pt) {
  const curves = Array.from({ length: RIM_N }, (_, k) => {
    const p0 = rimPoint(x, k, t);
    const ctrl: Pt = [(p0[0] + tail[0]) / 2, p0[1] * 0.75 + tail[1] * 0.25 + 30 * Math.sin(t * 3 + k)];
    return [p0, ctrl] as const;
  });
  let s = '';
  for (const [p0, ctrl] of curves) {
    s += `<path d="M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} Q${ctrl[0].toFixed(1)} ${ctrl[1].toFixed(1)} ${tail[0]} ${tail[1]}" fill="none" stroke="${C.cyan}" stroke-width="1.6" opacity="0.5"/>`;
  }
  for (let u = 0.1; u < 0.9; u += 0.1) {
    const pts = curves.map(([p0, ctrl]) => quad(p0, ctrl, tail, u));
    s += `<polyline points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${C.cyan}" stroke-width="1.3" opacity="${0.45 - u * 0.25}"/>`;
  }
  const rim = curves.map(([p0]) => p0);
  const rimPts = rim.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
  s += `<polyline points="${rimPts}" fill="none" stroke="${C.purple}" stroke-width="16" opacity="0.18" stroke-linecap="round"/>`;
  s += `<polyline points="${rimPts}" fill="none" stroke="${C.purple}" stroke-width="5" stroke-linecap="round"/>`;
  rim.forEach((p, k) => {
    if (k % 3 === 1) s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="9" fill="${C.orange}"/>`;
  });
  return g(s, `opacity="${op.toFixed(3)}"`);
}

function fragmentLayer(t: number, shake: Pt) {
  const nx = netX(t);
  const tail: Pt = [nx - 950, H / 2];
  let s = '';
  for (const f of frags) {
    const x = f.x0 + f.vx * t + shake[0];
    const y = f.y + 5 * Math.sin(t * 1.7 + f.bob) + shake[1];
    if (f.caught < 0 && t >= 5 && x + monoWidth(f.s, f.size) * 0.5 < rimXAt(nx, y, t)) {
      f.caught = t;
      f.cx = x;
      f.cy = y;
    }
    const appear = clamp(t / 1.2);
    if (f.caught < 0) {
      s += text(x, y, f.s, { size: f.size, fill: f.color, font: MONO, opacity: f.op * appear });
      continue;
    }
    const u = prog(t, f.caught, f.caught + 0.65);
    if (u < 1) {
      const e = inCubic(u);
      const px = lerp(f.cx, tail[0], e);
      const py = lerp(f.cy, tail[1], e);
      s += text(px, py, f.s, {
        size: f.size * (1 - 0.7 * e), fill: C.cyan, font: MONO, opacity: (1 - e) * 0.9, extra: `transform="${scaleAt(px, py, 1)}"`,
      });
    }
    const sp = prog(t, f.caught, f.caught + 0.35);
    if (sp > 0 && sp < 1) {
      s += `<circle cx="${f.cx.toFixed(1)}" cy="${(f.cy - f.size / 3).toFixed(1)}" r="${(8 + 34 * outCubic(sp)).toFixed(1)}" fill="none" stroke="${C.cyan}" stroke-width="2" opacity="${(1 - sp).toFixed(3)}"/>`;
    }
  }
  return s;
}

function scene1(t: number) {
  const msg = 'somewhere in your repo';
  const n = Math.floor(msg.length * prog(t, 0.45, 1.6));
  const size = 54;
  const x0 = W / 2 - monoWidth(msg, size) / 2;
  const op = window_(t, 0.3, 2.45, 0.2, 0.25);
  const lift = -30 * inCubic(prog(t, 2.2, 2.45));
  const cursorOn = Math.floor(t * 2.5) % 2 === 0 || (n > 0 && n < msg.length);
  return g(
    text(x0, H / 2 + 18 + lift, msg.slice(0, n), { size, font: MONO, fill: C.fg }) +
      (cursorOn ? `<rect x="${(x0 + monoWidth(msg.slice(0, n), size) + 4).toFixed(1)}" y="${H / 2 - 26 + lift}" width="28" height="56" fill="${C.blue}"/>` : ''),
    `opacity="${op.toFixed(3)}"`,
  );
}

const SLAMS = [
  { t: 2.5, s: '1,284 markdown files', c: C.fg },
  { t: 3.25, s: '73 mermaid diagrams', c: C.blue },
  { t: 4.0, s: 'zero idea where.', c: C.red },
];
function scene2(t: number) {
  let s = '';
  SLAMS.forEach((m, i) => {
    const end = i < SLAMS.length - 1 ? SLAMS[i + 1].t : 4.95;
    if (t < m.t || t > end) return;
    const u = prog(t, m.t, m.t + 0.28);
    const sc = lerp(1.45, 1, outExpo(u));
    const op = Math.min(prog(t, m.t, m.t + 0.06), 1 - prog(t, end - 0.07, end));
    s += g(text(W / 2, H / 2 + 42, m.s, { size: 124, weight: 700, fill: m.c, anchor: 'middle' }), `opacity="${op.toFixed(3)}" transform="${scaleAt(W / 2, H / 2, sc)}"`);
    const flash = 1 - prog(t, m.t, m.t + 0.25);
    if (flash > 0) s += `<rect width="${W}" height="${H}" fill="${m.c}" opacity="${(flash * 0.12).toFixed(3)}"/>`;
  });
  return s;
}

function slamShake(t: number): Pt {
  for (const m of [...SLAMS.map((x) => x.t), 18.25]) {
    const d = t - m;
    if (d >= 0 && d < 0.3) {
      const a = 14 * (1 - d / 0.3);
      return [a * Math.sin(d * 90), a * Math.cos(d * 70)];
    }
  }
  return [0, 0];
}

function scene3(t: number) {
  const nx = netX(t);
  const op = window_(t, 5, 8.3, 0.1, 0.3);
  const caption = window_(t, 7.0, 8.25, 0.25, 0.25);
  return (
    net(nx, t, op, [nx - 950, H / 2]) +
    g(text(W / 2, 985, 'trawl drags them all up.', { size: 64, weight: 700, anchor: 'middle', fill: C.fg }), `opacity="${caption.toFixed(3)}"`)
  );
}

// Tiles: 4x3 grid of real renders.
const TW = 400;
const TH = 236;
const GAP = 34;
const GX = (W - (4 * TW + 3 * GAP)) / 2;
const GY = 214;
const ACCENTS = [C.blue, C.purple, C.cyan, C.green, C.orange, C.red, C.yellow, C.teal, C.blue, C.purple, C.cyan, C.green];
const tilePos = (i: number): Pt => [GX + (i % 4) * (TW + GAP), GY + Math.floor(i / 4) * (TH + GAP)];
const DIVE_TILE = 0;

function scene4(t: number) {
  if (t < 7.9 || t > 12.3) return '';
  const camIn = lerp(1, 1.05, prog(t, 8, 11.4));
  // Dive into the first tile: zoom about it and bring it to the centre.
  const d = inCubic(prog(t, 11.4, 12.1));
  const [tx, ty] = tilePos(DIVE_TILE);
  const cx = lerp(W / 2, tx + TW / 2, outCubic(prog(t, 11.4, 11.9)));
  const cy = lerp(H / 2, ty + TH / 2, outCubic(prog(t, 11.4, 11.9)));
  const zoom = camIn * Math.exp(lerp(0, Math.log(14), d));
  let s = '';
  tiles.forEach((tile, i) => {
    const t0 = 8.0 + i * 0.11;
    const u = prog(t, t0, t0 + 0.5);
    if (u <= 0) return;
    const [x, y] = tilePos(i);
    const e = outBack(u);
    const sx = lerp(W / 2 - TW / 2 - 300, x, outCubic(u));
    const sy = lerp(H / 2 - TH / 2, y, outCubic(u));
    const rot = lerp(i % 2 ? 14 : -14, 0, outCubic(u));
    const others = i === DIVE_TILE ? 1 : 1 - prog(t, 11.4, 11.75);
    // Leave faded tiles out entirely: zoomed off-canvas, resvg still allocates a layer for each and crashes.
    if (others <= 0.001) return;
    const card =
      `<rect x="6" y="12" width="${TW}" height="${TH}" rx="16" fill="#000" opacity="0.35"/>` +
      `<rect width="${TW}" height="${TH}" rx="16" fill="#fff"/>` +
      `<rect width="${TW}" height="8" rx="4" fill="${ACCENTS[i]}"/>` +
      `<image href="${tile.href}" x="14" y="18" width="${TW - 28}" height="${TH - 32}" preserveAspectRatio="xMidYMid meet"/>`;
    s += g(card, `transform="translate(${sx.toFixed(1)} ${sy.toFixed(1)}) rotate(${rot.toFixed(2)} ${TW / 2} ${TH / 2}) ${scaleAt(TW / 2, TH / 2, Math.max(0.01, e))}" opacity="${(clamp(u * 3) * others).toFixed(3)}"`);
  });
  const title = window_(t, 8.5, 11.4, 0.25, 0.2);
  const titleSvg = g(
    text(W / 2, 140, 'rendered. every type. in milliseconds.', { size: 60, weight: 700, anchor: 'middle' }),
    `opacity="${title.toFixed(3)}" transform="translate(0 ${(-20 * (1 - outCubic(prog(t, 8.5, 8.9)))).toFixed(1)})"`,
  );
  const fade = 1 - prog(t, 11.95, 12.25);
  return g(g(s, `transform="translate(${W / 2} ${H / 2}) scale(${zoom.toFixed(4)}) translate(${-cx} ${-cy})"`) + titleSvg, `opacity="${fade.toFixed(3)}"`);
}

// "How trawl works" flowchart that draws itself.
type Node = { id: string; label: string; x: number; y: number; w: number; h: number; c: string; dark?: boolean; at: number; hex?: boolean };
const NODES: Node[] = [
  { id: 'a', label: 'README.md', x: 300, y: 330, w: 280, h: 86, c: C.blue, at: 12.15 },
  { id: 'b', label: 'docs/**/*.md', x: 300, y: 540, w: 280, h: 86, c: C.blue, at: 12.27 },
  { id: 'c', label: 'flows/*.mmd', x: 300, y: 750, w: 280, h: 86, c: C.blue, at: 12.39 },
  { id: 'hub', label: 'trawl', x: 900, y: 540, w: 330, h: 150, c: C.purple, at: 12.75, hex: true },
  { id: 'p', label: 'terminal preview', x: 1560, y: 270, w: 400, h: 86, c: C.teal, at: 13.35 },
  { id: 'q', label: 'PNG / SVG', x: 1560, y: 450, w: 400, h: 86, c: C.green, dark: true, at: 13.47 },
  { id: 'r', label: 'your browser', x: 1560, y: 630, w: 400, h: 86, c: C.orange, dark: true, at: 13.59 },
  { id: 's', label: 'CI lint', x: 1560, y: 810, w: 400, h: 86, c: C.red, at: 13.71 },
];
const node = (id: string) => NODES.find((n) => n.id === id)!;
const EDGES = [
  ['a', 'hub', 12.45], ['b', 'hub', 12.5], ['c', 'hub', 12.55],
  ['hub', 'p', 13.0], ['hub', 'q', 13.06], ['hub', 'r', 13.12], ['hub', 's', 13.18],
].map(([from, to, at]) => {
  const a = node(from as string);
  const b = node(to as string);
  const p0: Pt = [a.x + a.w / 2, a.y];
  const p3: Pt = [b.x - b.w / 2, b.y];
  const p1: Pt = [p0[0] + 160, p0[1]];
  const p2: Pt = [p3[0] - 160, p3[1]];
  let len = 0;
  let prev = p0;
  for (let i = 1; i <= 40; i++) {
    const p = cubic(p0, p1, p2, p3, i / 40);
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
  }
  return { pts: [p0, p1, p2, p3] as [Pt, Pt, Pt, Pt], at: at as number, len, c: b.id === 'hub' ? C.blue : b.c };
});

function scene5(t: number) {
  if (t < 11.9 || t > 15.2) return '';
  const op = Math.min(prog(t, 11.95, 12.2), 1 - prog(t, 14.85, 15.1));
  const cam = lerp(1.25, 1, outCubic(prog(t, 11.95, 12.9)));
  let s = '';
  for (const e of EDGES) {
    const u = outCubic(prog(t, e.at, e.at + 0.45));
    if (u <= 0) continue;
    const [p0, p1, p2, p3] = e.pts;
    const d = `M${p0} C${p1} ${p2} ${p3}`;
    s += `<path d="${d}" fill="none" stroke="${e.c}" stroke-width="10" opacity="0.15" stroke-dasharray="${e.len}" stroke-dashoffset="${(e.len * (1 - u)).toFixed(1)}"/>`;
    s += `<path d="${d}" fill="none" stroke="${e.c}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${e.len}" stroke-dashoffset="${(e.len * (1 - u)).toFixed(1)}"/>`;
    if (u >= 1) {
      for (let k = 0; k < 3; k++) {
        const ph = ((t - e.at) / 1.1 + k / 3) % 1;
        const [x, y] = cubic(p0, p1, p2, p3, ph);
        s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="${e.c}" opacity="0.25"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="#fff"/>`;
      }
    }
  }
  for (const n of NODES) {
    const u = prog(t, n.at, n.at + 0.4);
    if (u <= 0) continue;
    const sc = Math.max(0.01, outBack(u));
    const x = n.x - n.w / 2;
    const y = n.y - n.h / 2;
    const shape = n.hex
      ? `<polygon points="${x + 40},${y} ${x + n.w - 40},${y} ${x + n.w},${n.y} ${x + n.w - 40},${y + n.h} ${x + 40},${y + n.h} ${x},${n.y}" fill="${n.c}"/>`
      : `<rect x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="${n.h / 2}" fill="${n.c}"/>`;
    const glow = n.hex ? `<circle cx="${n.x}" cy="${n.y}" r="${230 + 40 * beatPulse(t, 12.75, 15)}" fill="${n.c}" opacity="0.12"/>` : '';
    const ring = prog(t, n.at, n.at + 0.5);
    const ringSvg = ring < 1 ? `<rect x="${x - 30 * ring}" y="${y - 30 * ring}" width="${n.w + 60 * ring}" height="${n.h + 60 * ring}" rx="${n.h / 2 + 30 * ring}" fill="none" stroke="${n.c}" stroke-width="3" opacity="${1 - ring}"/>` : '';
    const label = text(n.x, n.y + (n.hex ? 22 : 12), n.label, {
      size: n.hex ? 64 : 34, weight: 700, anchor: 'middle', fill: n.dark ? C.bg0 : '#fff', font: n.hex ? SANS : MONO,
    });
    s += glow + ringSvg + g(shape + label, `transform="${scaleAt(n.x, n.y, sc)}"`);
  }
  const title = window_(t, 13.8, 14.95, 0.25, 0.15);
  s += g(text(W / 2, 120, 'one tool. every diagram. everywhere.', { size: 56, weight: 700, anchor: 'middle' }), `opacity="${title.toFixed(3)}"`);
  return g(s, `opacity="${op.toFixed(3)}" transform="${scaleAt(W / 2, H / 2, cam)}"`);
}

const VERBS = [
  { t: 15.0, w: 'check', c: C.green, sub: 'lint every diagram · exit 1 on errors' },
  { t: 15.75, w: 'render', c: C.cyan, sub: 'PNG or SVG · no browser, no Chromium' },
  { t: 16.5, w: 'open', c: C.purple, sub: 'pop it open in feh or your browser' },
];
function scene6(t: number) {
  let s = '';
  VERBS.forEach((v, i) => {
    const end = i < VERBS.length - 1 ? VERBS[i + 1].t : 17.45;
    if (t < v.t || t > end) return;
    const u = prog(t, v.t, v.t + 0.3);
    const op = Math.min(prog(t, v.t, v.t + 0.05), 1 - prog(t, end - 0.08, end));
    const ring = outCubic(prog(t, v.t, v.t + 0.7));
    s += `<circle cx="${W / 2}" cy="${H / 2}" r="${(60 + 900 * ring).toFixed(1)}" fill="none" stroke="${v.c}" stroke-width="${(24 * (1 - ring) + 1).toFixed(1)}" opacity="${(1 - ring).toFixed(3)}"/>`;
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2 + i;
      const r0 = 260 + 500 * ring;
      const r1 = r0 + 70 * (1 - ring);
      s += `<line x1="${(W / 2 + Math.cos(a) * r0).toFixed(1)}" y1="${(H / 2 + Math.sin(a) * r0).toFixed(1)}" x2="${(W / 2 + Math.cos(a) * r1).toFixed(1)}" y2="${(H / 2 + Math.sin(a) * r1).toFixed(1)}" stroke="${v.c}" stroke-width="5" stroke-linecap="round" opacity="${(1 - ring).toFixed(3)}"/>`;
    }
    const sc = lerp(1.6, 1, outExpo(u));
    s += g(
      text(W / 2 - 170, H / 2 - 120, '$ trawl', { size: 52, font: MONO, fill: C.dim, anchor: 'middle' }) +
        text(W / 2, H / 2 + 70, v.w, { size: 230, weight: 700, fill: v.c, anchor: 'middle' }) +
        text(W / 2, H / 2 + 170, v.sub, { size: 38, font: MONO, fill: C.fg, anchor: 'middle', opacity: prog(t, v.t + 0.15, v.t + 0.35) }),
      `opacity="${op.toFixed(3)}" transform="${scaleAt(W / 2, H / 2, sc)}"`,
    );
  });
  return s;
}

function keycap(x: number, y: number, w: number, label: string, pressAt: number, t: number, color: string) {
  const h = 210;
  const down = t >= pressAt ? 1 - 0.35 * prog(t, pressAt + 0.35, pressAt + 0.6) : 0;
  const dy = 22 * outCubic(prog(t, pressAt, pressAt + 0.06)) * down;
  const lit = t >= pressAt ? 1 - 0.5 * prog(t, pressAt, pressAt + 0.8) : 0;
  return (
    `<rect x="${x}" y="${y + 26}" width="${w}" height="${h}" rx="30" fill="#0d0e17"/>` +
    `<rect x="${x}" y="${y + 26}" width="${w}" height="${h}" rx="30" fill="${color}" opacity="${(0.35 * lit).toFixed(3)}"/>` +
    `<rect x="${x}" y="${(y + dy).toFixed(1)}" width="${w}" height="${h}" rx="30" fill="${C.card}" stroke="${t >= pressAt ? color : '#414868'}" stroke-width="4"/>` +
    `<rect x="${x + 18}" y="${(y + dy + 14).toFixed(1)}" width="${w - 36}" height="${h - 60}" rx="22" fill="#292e42"/>` +
    text(x + w / 2, y + dy + h / 2 + 18, label, { size: 84, weight: 700, anchor: 'middle', fill: t >= pressAt ? color : C.fg })
  );
}

function scene7(t: number) {
  if (t < 17.4 || t > 19.75) return '';
  const appear = outBack(prog(t, 17.45, 17.85));
  const out = inCubic(prog(t, 19.15, 19.6));
  const sc = Math.max(0.01, appear) * (1 + 5 * out);
  let s = keycap(560, 400, 340, 'alt', 18.0, t, C.blue) + text(W / 2 + 20, 545, '+', { size: 110, weight: 700, anchor: 'middle', fill: C.dim }) + keycap(1100, 400, 250, 'm', 18.25, t, C.purple);
  for (let k = 0; k < 3; k++) {
    const r = outCubic(prog(t, 18.25 + k * 0.08, 18.25 + k * 0.08 + 0.8));
    if (r > 0 && r < 1) s += `<circle cx="${W / 2}" cy="${H / 2}" r="${(200 + 1100 * r).toFixed(1)}" fill="none" stroke="${[C.purple, C.blue, C.cyan][k]}" stroke-width="${(18 * (1 - r) + 1).toFixed(1)}" opacity="${(1 - r).toFixed(3)}"/>`;
  }
  s = g(s, `transform="${scaleAt(W / 2, H / 2, sc)}" opacity="${(1 - out).toFixed(3)}"`);
  s += text(W / 2, 800, 'from any prompt, in any repo', { size: 44, font: MONO, anchor: 'middle', opacity: window_(t, 18.4, 19.25, 0.2, 0.15) });
  const flash = Math.max(1 - prog(t, 18.25, 18.45), prog(t, 19.35, 19.6) * (1 - prog(t, 19.6, 19.9)));
  if (flash > 0) s += `<rect width="${W}" height="${H}" fill="#fff" opacity="${(flash * 0.35).toFixed(3)}"/>`;
  return s;
}

function scene8(t: number) {
  if (t < 19.5) return '';
  const op = 1 - prog(t, 22.9, 23.5);
  // A calm net behind the logo.
  const calm = net(W + 380, t, 0.35 * prog(t, 19.6, 20.4), [-200, H / 2 + 40]);
  const word = 'trawl';
  const rise = [...word].map((ch, i) => {
    const u = outBack(prog(t, 19.6 + i * 0.07, 19.6 + i * 0.07 + 0.45));
    return { ch, dy: 90 * (1 - u), op: clamp(u * 1.5) };
  });
  let dyPrev = 0;
  const tspans = rise
    .map((r) => {
      const s = `<tspan dy="${(r.dy - dyPrev).toFixed(1)}" fill-opacity="${r.op.toFixed(3)}">${r.ch}</tspan>`;
      dyPrev = r.dy;
      return s;
    })
    .join('');
  const logo = `<text x="${W / 2}" y="${H / 2 + 40}" font-family="${SANS}" font-size="280" font-weight="700" fill="url(#logo)" text-anchor="middle">${tspans}</text>`;
  const tag = 'every mermaid diagram, caught.';
  const n = Math.floor(tag.length * prog(t, 20.4, 21.4));
  const ts = 46;
  const tx = W / 2 - monoWidth(tag, ts) / 2;
  const blink = Math.floor(t * 2.5) % 2 === 0 || (n > 0 && n < tag.length);
  const underline = outCubic(prog(t, 20.0, 20.6));
  return g(
    calm +
      bubbleLayer(t, 0.6 * prog(t, 19.6, 20.6)) +
      logo +
      `<path d="M${W / 2 - 330} ${H / 2 + 95} Q${W / 2} ${H / 2 + 150} ${W / 2 + 330} ${H / 2 + 95}" fill="none" stroke="${C.purple}" stroke-width="6" stroke-linecap="round" stroke-dasharray="760" stroke-dashoffset="${(760 * (1 - underline)).toFixed(1)}"/>` +
      text(tx, H / 2 + 220, tag.slice(0, n), { size: ts, font: MONO, fill: C.fg }) +
      (blink && t > 20.3 ? `<rect x="${(tx + monoWidth(tag.slice(0, n), ts) + 4).toFixed(1)}" y="${H / 2 + 184}" width="24" height="48" fill="${C.blue}"/>` : '') +
      text(W / 2, H / 2 + 310, 'github.com/snowu/trawl', { size: 36, anchor: 'middle', fill: C.dim, opacity: prog(t, 21.5, 22.0) }),
    `opacity="${op.toFixed(3)}"`,
  );
}

function frame(t: number) {
  const shake = slamShake(t);
  const fragOp = 1 - prog(t, 8.2, 8.6);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${background(t)}
  ${bubbleLayer(t, (1 - prog(t, 7.6, 8.4)) * prog(t, 0, 1))}
  ${fragOp > 0 ? g(fragmentLayer(t, shake), `opacity="${fragOp.toFixed(3)}"`) : ''}
  ${t < 2.6 ? scene1(t) : ''}
  ${t >= 2.4 && t < 5 ? g(scene2(t), `transform="translate(${shake[0].toFixed(1)} ${shake[1].toFixed(1)})"`) : ''}
  ${t >= 4.9 && t < 8.4 ? scene3(t) : ''}
  ${scene4(t)}
  ${scene5(t)}
  ${t >= 14.9 && t < 17.6 ? scene6(t) : ''}
  ${g(scene7(t), `transform="translate(${shake[0].toFixed(1)} ${shake[1].toFixed(1)})"`)}
  ${scene8(t)}
</svg>`;
}

/** wasm memory isn't garbage collected: free each frame's renderer and image, or it runs out mid-video. */
function toPng(t: number) {
  const resvg = new Resvg(frame(t), { background: C.bg0, font });
  const image = resvg.render();
  const png = image.asPng();
  image.free();
  resvg.free();
  return png;
}

if (process.env.ONLY) {
  // Advance the stateful bits (caught fragments) up to the requested time, then render one frame.
  const only = Number(process.env.ONLY);
  for (let t = 0; t < only; t += 1 / FPS) frame(t);
  await Bun.write(join(BUILD, "frame.svg"), frame(only));
  await Bun.write(join(BUILD, "frame.png"), toPng(only));
  console.log(join(BUILD, 'frame.png'));
  process.exit(0);
}

const wav = join(BUILD, 'music.wav');
const out = join(ROOT, 'demo', 'trawl-vibe.mp4');
const ffmpeg = Bun.spawn(
  ['ffmpeg', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    ...(existsSync(wav) ? ['-i', wav, '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
  { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' },
);
const total = Math.round(DUR * FPS);
const started = performance.now();
for (let i = 0; i < total; i++) {
  ffmpeg.stdin.write(toPng(i / FPS));
  if (i % FPS === 0) {
    await ffmpeg.stdin.flush();
    const rate = (i + 1) / ((performance.now() - started) / 1000);
    process.stderr.write(`\r${i}/${total} frames · ${rate.toFixed(1)} fps   `);
  }
}
ffmpeg.stdin.end();
await ffmpeg.exited;
console.error(`\n${out}`);
