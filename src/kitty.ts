// Inline images via the kitty graphics protocol (kitty, Ghostty, WezTerm):
// https://sw.kovidgoyal.net/kitty/graphics-protocol/

const IMAGE_ID = 7_341;
const ESC = '\x1b';

/** How the picker shows real images: the kitty protocol, sixel, or not at all (box-drawing art). */
export type ImageMode = 'kitty' | 'sixel' | false;

/**
 * Inline image support from the environment alone. TRAWL_IMAGES=0/1/kitty/sixel overrides the detection;
 * otherwise kitty-protocol terminals by name, and sixel for Windows Terminal. `detectImages` also asks the
 * terminal itself, which catches every other sixel terminal.
 */
export function imagesSupported(env: Record<string, string | undefined> = process.env): ImageMode {
  const forced = env.TRAWL_IMAGES;
  if (forced === '0') return false;
  if (forced === '1' || forced === 'kitty') return 'kitty';
  if (forced === 'sixel') return 'sixel';
  // shortcut: tmux needs passthrough wrapping for the protocols; fall back to ASCII there until someone asks.
  if (env.TMUX) return false;
  if (
    env.TERM === 'xterm-kitty' ||
    env.TERM === 'xterm-ghostty' ||
    env.TERM_PROGRAM === 'ghostty' ||
    env.TERM_PROGRAM === 'WezTerm' ||
    env.KITTY_WINDOW_ID !== undefined
  ) {
    return 'kitty';
  }
  if (env.WT_SESSION) return 'sixel';
  return false;
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

/** Cell height / width in pixels. 2 is typical; detectImages() measures the real one. */
let cellAspect = 2;
/**
 * Cell size in pixels, needed to size sixel images (kitty scales to cells itself). The default is deliberately
 * small: a sixel image taller than its box scrolls the whole screen, one that's a bit small is harmless.
 */
export const cellPixels = { width: 8, height: 16 };
/** Whether cellPixels was measured (terminal reply, or TRAWL_CELL=WxH) rather than guessed. */
export let cellMeasured = false;

/**
 * Reads the replies to CSI 16 t (cell size), CSI 14 t (text area size, divided by the terminal's columns and
 * rows when 16 t went unanswered) and DA1 (attribute 4 = sixel).
 */
export function parseTerminalReplies(
  reply: string,
  grid: { columns: number; rows: number } = { columns: process.stdout.columns ?? 0, rows: process.stdout.rows ?? 0 },
): { cell?: { width: number; height: number }; sixel: boolean } {
  const size = /\x1b\[6;(\d+);(\d+)t/.exec(reply);
  const area = /\x1b\[4;(\d+);(\d+)t/.exec(reply);
  const da1 = /\x1b\[\?([\d;]*)c/.exec(reply);
  let cell: { width: number; height: number } | undefined;
  if (size && Number(size[1]) > 0 && Number(size[2]) > 0) cell = { height: Number(size[1]), width: Number(size[2]) };
  else if (area && grid.columns > 0 && grid.rows > 0 && Number(area[1]) > 0 && Number(area[2]) > 0) {
    cell = { height: Math.floor(Number(area[1]) / grid.rows), width: Math.floor(Number(area[2]) / grid.columns) };
  }
  return { cell, sixel: !!da1 && da1[1].split(';').includes('4') };
}

/**
 * Asks the terminal for its cell size in pixels (CSI 16 t, or 14 t) and its attributes (DA1), before Ink takes over
 * stdin: images keep their proportions with any font, and terminals that report sixel get it even when the
 * environment doesn't say what they are. Every terminal answers DA1, so the wait ends as soon as it arrives.
 */
export async function detectImages(env: Record<string, string | undefined> = process.env, timeoutMs = 250): Promise<ImageMode> {
  let mode = imagesSupported(env);
  const forcedCell = /^(\d+)x(\d+)$/.exec(env.TRAWL_CELL ?? '');
  if (forcedCell) {
    Object.assign(cellPixels, { width: Number(forcedCell[1]), height: Number(forcedCell[2]) });
    cellAspect = cellPixels.height / cellPixels.width;
    cellMeasured = true;
  }
  const stdin = process.stdin;
  if (!stdin.isTTY || env.TMUX || env.TRAWL_IMAGES === '0') return mode;
  stdin.setRawMode(true);
  stdin.resume();
  const reply = await new Promise<string>((resolve) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (/\x1b\[\?[\d;]*c/.test(buffer)) done();
    };
    const done = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      resolve(buffer);
    };
    const timer = setTimeout(done, timeoutMs);
    stdin.on('data', onData);
    process.stdout.write('\x1b[16t\x1b[14t\x1b[c');
  });
  // Leave stdin flowing: pausing it lets Bun end the process once Ink takes over (the picker vanished on its own).
  stdin.setRawMode(false);
  const { cell, sixel } = parseTerminalReplies(reply);
  if (cell && !forcedCell) {
    cellAspect = cell.height / cell.width;
    Object.assign(cellPixels, cell);
    cellMeasured = true;
  }
  if (!mode && sixel && env.TRAWL_IMAGES === undefined) mode = 'sixel';
  return mode;
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
