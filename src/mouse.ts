// Mouse input via xterm SGR mouse reporting (CSI < b ; x ; y M/m), which every modern terminal speaks.

/** Turn on reporting of clicks, drags (motion while a button is held) and the wheel, in SGR encoding. */
export const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

export interface MouseEvent {
  kind: 'press' | 'release' | 'drag' | 'wheel-up' | 'wheel-down';
  button: 'left' | 'middle' | 'right' | 'none';
  /** 1-based terminal column and row. */
  col: number;
  row: number;
}

const BUTTONS = ['left', 'middle', 'right', 'none'] as const;

/** Every mouse event in a chunk of raw terminal input (other input is ignored). */
export function parseMouse(chunk: string): MouseEvent[] {
  return [...chunk.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)].map(([, code, col, row, end]) => {
    const b = Number(code);
    const button = BUTTONS[b & 3];
    // Bit 64 marks the wheel (low bits 0 = up, 1 = down), bit 32 motion; modifier bits 4/8/16 are ignored.
    const kind = b & 64 ? (b & 1 ? 'wheel-down' : 'wheel-up') : b & 32 ? 'drag' : end === 'm' ? 'release' : 'press';
    return { kind, button, col: Number(col), row: Number(row) };
  });
}
