// Inline images via the kitty graphics protocol (kitty, Ghostty, WezTerm):
// https://sw.kovidgoyal.net/kitty/graphics-protocol/

const IMAGE_ID = 7_341;
const ESC = '\x1b';

/** Whether the terminal can show inline images. TRAWL_IMAGES=0/1 overrides the detection. */
export function imagesSupported(env: Record<string, string | undefined> = process.env): boolean {
  if (env.TRAWL_IMAGES === '0' || env.TRAWL_IMAGES === '1') return env.TRAWL_IMAGES === '1';
  // shortcut: tmux needs passthrough wrapping for the protocol; fall back to ASCII there until someone asks.
  if (env.TMUX) return false;
  return (
    env.TERM === 'xterm-kitty' ||
    env.TERM === 'xterm-ghostty' ||
    env.TERM_PROGRAM === 'ghostty' ||
    env.TERM_PROGRAM === 'WezTerm' ||
    env.KITTY_WINDOW_ID !== undefined
  );
}

/** Pixel size from a PNG's IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface Box {
  /** 1-based terminal row and column of the box's top-left cell. */
  row: number;
  col: number;
  /** Size in cells. */
  cols: number;
  rows: number;
}

/** Cell height / width in pixels. 2 is typical; queryCellAspect() measures the real one. */
let cellAspect = 2;

/**
 * Asks the terminal for its cell size in pixels (CSI 16 t, answered as CSI 6 ; h ; w t) so images keep their
 * proportions with any font. Run before Ink takes over stdin; keeps the default if there's no answer in time.
 */
export async function queryCellAspect(timeoutMs = 200): Promise<void> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return;
  stdin.setRawMode(true);
  stdin.resume();
  const reply = await new Promise<string>((resolve) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (/\x1b\[6;\d+;\d+t/.test(buffer)) done();
    };
    const done = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      resolve(buffer);
    };
    const timer = setTimeout(done, timeoutMs);
    stdin.on('data', onData);
    process.stdout.write('\x1b[16t');
  });
  stdin.setRawMode(false);
  stdin.pause();
  const m = /\x1b\[6;(\d+);(\d+)t/.exec(reply);
  if (m && Number(m[2]) > 0) cellAspect = Number(m[1]) / Number(m[2]);
}

/**
 * The cell size that fits the image into the box without distortion. The terminal scales the image to
 * exactly that many cells, so both are derived from the image's own aspect ratio.
 */
export function fitCells(png: Uint8Array, box: Pick<Box, 'cols' | 'rows'>): { cols: number; rows: number } {
  const { width, height } = pngSize(png);
  const rowsForFullWidth = (box.cols * height) / (width * cellAspect);
  if (rowsForFullWidth <= box.rows) return { cols: box.cols, rows: Math.max(1, Math.round(rowsForFullWidth)) };
  return { cols: Math.max(1, Math.round((box.rows * width * cellAspect) / height)), rows: box.rows };
}

/**
 * Escape sequence that uploads the PNG as trawl's image, replacing the previous one, without showing it yet.
 * Uploading once and placing on every redraw keeps redraws cheap.
 */
export function transmitImage(png: Uint8Array): string {
  const chunks = Buffer.from(png).toString('base64').match(/.{1,4096}/g) ?? [];
  // a=t transmit only, f=100 PNG, q=2 no replies (they'd arrive as typed input).
  const head = `a=t,f=100,i=${IMAGE_ID},q=2,`;
  return clearImage() + chunks.map((c, i) => `${ESC}_G${i === 0 ? head : ''}m=${i < chunks.length - 1 ? 1 : 0};${c}${ESC}\\`).join('');
}

/**
 * Escape sequence that shows the uploaded image scaled into the box (replacing any earlier placement). A zoomed
 * viewport shows just that part of the PNG (x/y/w/h source crop), stretched over the same cells.
 */
export function placeImage(png: Uint8Array, box: Box, view: Viewport = FULL_VIEW): string {
  const { row, col, cols, rows } = imageArea(png, box);
  const { width, height } = pngSize(png);
  const crop =
    view.zoom > 1
      ? `x=${Math.round(view.x)},y=${Math.round(view.y)},w=${Math.round(width / view.zoom)},h=${Math.round(height / view.zoom)},`
      : '';
  // ESC 7 / ESC 8 save and restore the cursor, so the picker's own drawing isn't disturbed; C=1 keeps it put too.
  return `${ESC}7${ESC}[${row};${col}H${ESC}_Ga=d,d=i,i=${IMAGE_ID},q=2${ESC}\\${ESC}_Ga=p,i=${IMAGE_ID},${crop}c=${cols},r=${rows},q=2,C=1${ESC}\\${ESC}8`;
}

/** Escape sequence that takes trawl's image off screen but keeps it uploaded. */
export function hideImage(): string {
  return `${ESC}_Ga=d,d=i,i=${IMAGE_ID},q=2${ESC}\\`;
}

/** Escape sequence that removes trawl's image and frees its data. */
export function clearImage(): string {
  return `${ESC}_Ga=d,d=I,i=${IMAGE_ID},q=2${ESC}\\`;
}

/** Where the image lands: fitted into the box and centered horizontally. */
export function imageArea(png: Uint8Array, box: Box): Box {
  const { cols, rows } = fitCells(png, box);
  return { row: box.row, col: box.col + Math.floor((box.cols - cols) / 2), cols, rows };
}

/** Which part of the PNG (in its pixels) is on screen: all of it at zoom 1. */
export interface Viewport {
  zoom: number;
  x: number;
  y: number;
}

export const FULL_VIEW: Viewport = { zoom: 1, x: 0, y: 0 };
const MAX_ZOOM = 8;

/** Keeps the visible window inside the image. */
function clampView(png: Uint8Array, zoom: number, x: number, y: number): Viewport {
  const { width, height } = pngSize(png);
  const z = Math.min(MAX_ZOOM, Math.max(1, zoom));
  return {
    zoom: z,
    x: Math.min(Math.max(0, x), width - width / z),
    y: Math.min(Math.max(0, y), height - height / z),
  };
}

/** Zooms by `factor`, keeping the image point under (fx, fy) — fractions 0..1 of the shown area — in place. */
export function zoomAt(png: Uint8Array, view: Viewport, factor: number, fx: number, fy: number): Viewport {
  const { width, height } = pngSize(png);
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor));
  const px = view.x + (fx * width) / view.zoom;
  const py = view.y + (fy * height) / view.zoom;
  return clampView(png, zoom, px - (fx * width) / zoom, py - (fy * height) / zoom);
}

/** Moves the window by a drag of (dfx, dfy) fractions of the shown area (content follows the pointer). */
export function panBy(png: Uint8Array, view: Viewport, dfx: number, dfy: number): Viewport {
  const { width, height } = pngSize(png);
  return clampView(png, view.zoom, view.x - (dfx * width) / view.zoom, view.y - (dfy * height) / view.zoom);
}
