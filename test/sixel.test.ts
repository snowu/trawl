import { describe, expect, test } from 'bun:test';
import { encodeSixel, palette, type Rgba, scaleCrop } from '../src/sixel.ts';
import { svgToRgba, toSvg } from '../src/render.ts';

/** Minimal sixel decoder (palette, #color, !repeat, $ and -), enough to check what the encoder wrote. */
function decode(sixel: string): Rgba {
  const body = /\x1bP[\d;]*q"1;1;(\d+);(\d+)([\s\S]*)\x1b\\/.exec(sixel)!;
  const w = Number(body[1]), h = Number(body[2]);
  const data = new Uint8Array(w * h * 4);
  const pal: number[][] = [];
  let color = 0, x = 0, band = 0;
  const src = body[3];
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '#') {
      const m = /^#(\d+)(?:;2;(\d+);(\d+);(\d+))?/.exec(src.slice(i))!;
      if (m[2] !== undefined) pal[Number(m[1])] = [m[2], m[3], m[4]].map((v) => Math.round((Number(v) * 255) / 100));
      else color = Number(m[1]);
      i += m[0].length;
    } else if (c === '$') (x = 0), i++;
    else if (c === '-') (x = 0), band++, i++;
    else {
      let run = 1;
      if (c === '!') {
        const m = /^!(\d+)/.exec(src.slice(i))!;
        run = Number(m[1]);
        i += m[0].length;
      }
      const bits = src.charCodeAt(i++) - 63;
      for (let k = 0; k < run; k++, x++)
        for (let r = 0; r < 6; r++)
          if (bits & (1 << r) && band * 6 + r < h) data.set([...pal[color], 255], ((band * 6 + r) * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

function solid(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...paint(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

describe('sixel', () => {
  test('round-trips a flat-color image exactly (within palette rounding)', () => {
    const img = solid(37, 23, (x, y) => (x < 10 ? [255, 255, 255] : y < 12 ? [205, 244, 211] : [255, 117, 86]));
    const back = decode(encodeSixel(img));
    expect(back.width).toBe(37);
    expect(back.height).toBe(23);
    for (let i = 0; i < img.data.length; i++) expect(Math.abs(back.data[i] - img.data[i])).toBeLessThanOrEqual(8);
  });

  test('palette keeps the popular colors and stays within 255', () => {
    const noisy = solid(64, 64, (x, y) => [(x * 4) & 255, (y * 4) & 255, ((x + y) * 2) & 255]);
    expect(palette(noisy).length).toBeLessThanOrEqual(255);
    expect(palette(solid(4, 4, () => [10, 20, 30]))).toHaveLength(1);
  });

  test('scaleCrop averages areas and crops to the zoomed window', () => {
    const img = solid(4, 2, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255]));
    expect([...scaleCrop(img, { zoom: 1, x: 0, y: 0 }, 1, 1).data.slice(0, 3)]).toEqual([127, 127, 127]);
    expect([...scaleCrop(img, { zoom: 2, x: 2, y: 0 }, 1, 1).data.slice(0, 3)]).toEqual([255, 255, 255]);
  });

  test('a real diagram encodes to a reasonable size', async () => {
    const rgba = await svgToRgba(toSvg('flowchart LR\n  a[Cart] --> b{Pay?} -->|yes| c[(Ledger)]'));
    const small = scaleCrop(rgba, { zoom: 1, x: 0, y: 0 }, 600, Math.round((600 * rgba.height) / rgba.width));
    const out = encodeSixel(small);
    expect(out).toStartWith('\x1bP0;1;0q"1;1;600;');
    expect(out.length).toBeLessThan(400_000);
  });
});
