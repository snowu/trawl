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

// shortcut: assumes cells are about twice as tall as wide; query the real cell size (CSI 16 t) if images look squashed.
const CELL_ASPECT = 2;

/**
 * The cell size that fits the image into the box without distortion. The terminal scales the image to
 * exactly that many cells, so both are derived from the image's own aspect ratio.
 */
export function fitCells(png: Uint8Array, box: Pick<Box, 'cols' | 'rows'>): { cols: number; rows: number } {
  const { width, height } = pngSize(png);
  const rowsForFullWidth = (box.cols * height) / (width * CELL_ASPECT);
  if (rowsForFullWidth <= box.rows) return { cols: box.cols, rows: Math.max(1, Math.round(rowsForFullWidth)) };
  return { cols: Math.max(1, Math.round((box.rows * width * CELL_ASPECT) / height)), rows: box.rows };
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

/** Escape sequence that shows the uploaded image scaled into the box (replacing any earlier placement). */
export function placeImage(png: Uint8Array, box: Box): string {
  const { cols, rows } = fitCells(png, box);
  // ESC 7 / ESC 8 save and restore the cursor, so the picker's own drawing isn't disturbed; C=1 keeps it put too.
  return `${ESC}7${ESC}[${box.row};${box.col}H${ESC}_Ga=d,d=i,i=${IMAGE_ID},q=2${ESC}\\${ESC}_Ga=p,i=${IMAGE_ID},c=${cols},r=${rows},q=2,C=1${ESC}\\${ESC}8`;
}

/** Escape sequence that takes trawl's image off screen but keeps it uploaded. */
export function hideImage(): string {
  return `${ESC}_Ga=d,d=i,i=${IMAGE_ID},q=2${ESC}\\`;
}

/** Escape sequence that removes trawl's image and frees its data. */
export function clearImage(): string {
  return `${ESC}_Ga=d,d=I,i=${IMAGE_ID},q=2${ESC}\\`;
}
