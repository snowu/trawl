import { describe, expect, test } from 'bun:test';
import { FULL_VIEW, fitCells, imagesSupported, panBy, pngSize, transmitImage, zoomAt } from '../src/kitty.ts';
import { parseMouse } from '../src/mouse.ts';

/** A PNG header with the given size (enough for pngSize / fitCells, which only read IHDR). */
function fakePng(width: number, height: number): Uint8Array {
  const png = new Uint8Array(24);
  const view = new DataView(png.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return png;
}

describe('imagesSupported', () => {
  test('detects kitty-protocol terminals, not tmux, and honours TRAWL_IMAGES', () => {
    expect(imagesSupported({ TERM_PROGRAM: 'ghostty' })).toBe(true);
    expect(imagesSupported({ TERM: 'xterm-kitty' })).toBe(true);
    expect(imagesSupported({ TERM: 'alacritty' })).toBe(false);
    expect(imagesSupported({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux' })).toBe(false);
    expect(imagesSupported({ TERM_PROGRAM: 'ghostty', TRAWL_IMAGES: '0' })).toBe(false);
    expect(imagesSupported({ TERM: 'alacritty', TRAWL_IMAGES: '1' })).toBe(true);
  });
});

describe('fitCells', () => {
  test('reads the PNG size', () => {
    expect(pngSize(fakePng(800, 600))).toEqual({ width: 800, height: 600 });
  });

  test('wide images fill the width, tall ones the height, aspect kept (cells are 1:2)', () => {
    expect(fitCells(fakePng(1000, 100), { cols: 100, rows: 40 })).toEqual({ cols: 100, rows: 5 });
    expect(fitCells(fakePng(100, 1000), { cols: 100, rows: 40 })).toEqual({ cols: 8, rows: 40 });
  });
});

describe('transmitImage', () => {
  test('chunks the base64 payload at 4096 bytes, only the last chunk has m=0', () => {
    const seq = transmitImage(new Uint8Array(6000)); // 8000 base64 chars -> 2 chunks
    const chunks = [...seq.matchAll(/\x1b_G([^;\x1b]*);/g)].map((m) => m[1]);
    expect(chunks).toEqual(['a=t,f=100,i=7341,q=2,m=1', 'm=0']);
  });
});

describe('viewport', () => {
  const png = fakePng(1000, 500);

  test('zoomAt keeps the point under the pointer fixed and stays inside the image', () => {
    const view = zoomAt(png, FULL_VIEW, 2, 0.5, 0.5);
    expect(view).toEqual({ zoom: 2, x: 250, y: 125 });
    expect(zoomAt(png, FULL_VIEW, 2, 0, 0)).toEqual({ zoom: 2, x: 0, y: 0 });
    expect(zoomAt(png, view, 0.1, 0.5, 0.5)).toEqual(FULL_VIEW); // can't zoom out past fit
  });

  test('panBy moves the content with the drag, clamped at the edges', () => {
    const view = zoomAt(png, FULL_VIEW, 2, 0.5, 0.5);
    expect(panBy(png, view, 0.1, 0)).toEqual({ zoom: 2, x: 200, y: 125 }); // drag right shows more of the left
    expect(panBy(png, view, -5, -5)).toEqual({ zoom: 2, x: 500, y: 250 });
  });

  test('parseMouse decodes SGR clicks, drags, releases and the wheel', () => {
    expect(parseMouse('\x1b[<0;10;5M\x1b[<32;11;5M\x1b[<0;11;5m\x1b[<65;3;4M\x1b[<2;1;1M')).toEqual([
      { kind: 'press', button: 'left', col: 10, row: 5 },
      { kind: 'drag', button: 'left', col: 11, row: 5 },
      { kind: 'release', button: 'left', col: 11, row: 5 },
      { kind: 'wheel-down', button: 'middle', col: 3, row: 4 },
      { kind: 'press', button: 'right', col: 1, row: 1 },
    ]);
  });
});
