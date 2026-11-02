// Inline images via sixel (Windows Terminal 1.22+, foot, mlterm, xterm -ti vt340, recent iTerm2/WezTerm/Konsole):
// https://vt100.net/docs/vt3xx-gp/chapter14.html
// Sixel paints pixels into the cells (no separate image layer like kitty), so text redraws erase it and the
// picker repaints the image after every frame.

export interface Rgba {
  width: number;
  height: number;
  /** width * height * 4 bytes, row-major RGBA. */
  data: Uint8Array;
}

/** Part of the source image to show, in its pixels (same shape as kitty.ts's Viewport). */
export interface Crop {
  zoom: number;
  x: number;
  y: number;
}

/**
 * The `crop` window of `src` scaled to outW x outH with area averaging (box filter), which keeps thin lines and
 * small text legible when shrinking a 2x render down to terminal-cell size. Alpha is composited over white.
 */
export function scaleCrop(src: Rgba, crop: Crop, outW: number, outH: number): Rgba {
  const sw = src.width / crop.zoom;
  const sh = src.height / crop.zoom;
  const out = new Uint8Array(outW * outH * 4);
  const fx = sw / outW;
  const fy = sh / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = crop.y + oy * fy;
    const y1 = y0 + fy;
    const ya = Math.floor(y0);
    const yb = Math.min(src.height, Math.max(ya + 1, Math.ceil(y1)));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = crop.x + ox * fx;
      const x1 = x0 + fx;
      const xa = Math.floor(x0);
      const xb = Math.min(src.width, Math.max(xa + 1, Math.ceil(x1)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = ya; y < yb; y++) {
        let i = (y * src.width + xa) * 4;
        for (let x = xa; x < xb; x++, i += 4) {
          const a = src.data[i + 3] / 255;
          r += src.data[i] * a + 255 * (1 - a);
          g += src.data[i + 1] * a + 255 * (1 - a);
          b += src.data[i + 2] * a + 255 * (1 - a);
          n++;
        }
      }
      const o = (oy * outW + ox) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out };
}

/** 15-bit color key (5 bits per channel). */
const key15 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/**
 * Picks up to `max` palette colors by popularity over a 5-bit-per-channel histogram. Diagrams are mostly a few flat
 * fills plus anti-aliasing, so the popular colors are the real ones; rare edge shades map to their nearest.
 */
export function palette(img: Rgba, max = 255): [number, number, number][] {
  const counts = new Uint32Array(32768);
  for (let i = 0; i < img.data.length; i += 4) counts[key15(img.data[i], img.data[i + 1], img.data[i + 2])]++;
  const used: number[] = [];
  for (let k = 0; k < counts.length; k++) if (counts[k]) used.push(k);
  used.sort((a, b) => counts[b] - counts[a]);
  return used.slice(0, max).map((k) => {
    // Bin centers, so mid-tones don't all darken.
    const c = (v: number) => Math.min(255, (v << 3) | 4);
    return [c(k >> 10), c((k >> 5) & 31), c(k & 31)];
  });
}

/** Sixel data for the image (DCS … ST), palette included. Draw it at the cursor; it covers ceil(h/cellH) rows. */
export function encodeSixel(img: Rgba): string {
  const pal = palette(img);
  const nearest = new Int16Array(32768).fill(-1);
  const indexOf = (r: number, g: number, b: number) => {
    const k = key15(r, g, b);
    if (nearest[k] >= 0) return nearest[k];
    let best = 0, bestD = Infinity;
    for (let p = 0; p < pal.length; p++) {
      const dr = pal[p][0] - r, dg = pal[p][1] - g, db = pal[p][2] - b;
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) (bestD = d), (best = p);
    }
    return (nearest[k] = best);
  };
  const { width: w, height: h } = img;
  const idx = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < idx.length; p++, i += 4) idx[p] = indexOf(img.data[i], img.data[i + 1], img.data[i + 2]);

  // P2=1: pixels a color doesn't set keep what's under them (every pixel gets exactly one color anyway).
  const parts: string[] = [`\x1bP0;1;0q"1;1;${w};${h}`];
  pal.forEach(([r, g, b], p) => parts.push(`#${p};2;${Math.round((r * 100) / 255)};${Math.round((g * 100) / 255)};${Math.round((b * 100) / 255)}`));

  const bits = new Uint8Array(w);
  for (let band = 0; band < h; band += 6) {
    const rows = Math.min(6, h - band);
    const present = new Set<number>();
    for (let y = band; y < band + rows; y++) for (let x = 0; x < w; x++) present.add(idx[y * w + x]);
    const lines: string[] = [];
    for (const color of present) {
      bits.fill(0);
      for (let r = 0; r < rows; r++) {
        const row = (band + r) * w;
        for (let x = 0; x < w; x++) if (idx[row + x] === color) bits[x] |= 1 << r;
      }
      let line = `#${color}`;
      for (let x = 0; x < w; ) {
        let run = 1;
        while (x + run < w && bits[x + run] === bits[x]) run++;
        const ch = String.fromCharCode(63 + bits[x]);
        line += run > 3 ? `!${run}${ch}` : ch.repeat(run);
        x += run;
      }
      // Pixels this color doesn't set at the end of the row needn't be sent.
      lines.push(line.replace(/(?:!\d+\?|\?)+$/, ''));
    }
    parts.push(`${lines.join('$')}-`);
  }
  parts.push('\x1b\\');
  return parts.join('');
}

/** `img` drawn at the top-left of a `width` x `height` canvas filled with `bg`. */
export function padTo(img: Rgba, width: number, height: number, bg: [number, number, number]): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) (data[i] = bg[0]), (data[i + 1] = bg[1]), (data[i + 2] = bg[2]), (data[i + 3] = 255);
  const w = Math.min(width, img.width);
  for (let y = 0; y < Math.min(height, img.height); y++) data.set(img.data.subarray(y * img.width * 4, (y * img.width + w) * 4), y * width * 4);
  return { width, height, data };
}
