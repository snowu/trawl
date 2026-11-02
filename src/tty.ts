// The terminal's pixel size in the kernel's winsize record, which is what fzf reads (ioctl TIOCGWINSZ) to work out
// how many preview lines a sixel image covers. Many terminals, ConPTY (Windows Terminal + WSL) among them, leave it
// 0; fzf then assumes every image needs the whole preview and draws a placeholder instead. When trawl has measured
// the cell size itself (CSI 16 t), it fills the record in before starting fzf.
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { closeSync, openSync } from 'node:fs';

const IOCTL = {
  linux: { get: 0x5413, set: 0x5414, libc: 'libc.so.6' },
  darwin: { get: 0x40087468, set: 0x80087467, libc: 'libc.dylib' },
} as const;

/** rows, cols, xpixel, ypixel as the kernel stores them (four unsigned shorts). */
export interface Winsize {
  rows: number;
  cols: number;
  xpixel: number;
  ypixel: number;
}

function withTty<T>(fn: (fd: number, ioctl: (fd: number, req: number, buf: Uint16Array) => number) => T): T | null {
  const consts = IOCTL[process.platform as keyof typeof IOCTL];
  if (!consts) return null;
  let fd = -1;
  try {
    const lib = dlopen(consts.libc, { ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 } });
    fd = openSync('/dev/tty', 'r+');
    return fn(fd, (f, req, buf) => lib.symbols.ioctl(f, req, ptr(buf)));
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

export function getWinsize(): Winsize | null {
  const consts = IOCTL[process.platform as keyof typeof IOCTL];
  return withTty((fd, ioctl) => {
    const buf = new Uint16Array(4);
    if (ioctl(fd, consts.get, buf) !== 0) return null;
    return { rows: buf[0], cols: buf[1], xpixel: buf[2], ypixel: buf[3] };
  });
}

/**
 * Makes sure the winsize record carries a pixel size: keeps one the terminal set, else fills in cols x rows cells of
 * `cell` pixels. True when it now holds one.
 */
export function ensurePixelSize(cell: { width: number; height: number }): boolean {
  const consts = IOCTL[process.platform as keyof typeof IOCTL];
  const ws = getWinsize();
  if (!ws || !consts) return false;
  if (ws.xpixel > 0 && ws.ypixel > 0) return true;
  const ok = withTty((fd, ioctl) => ioctl(fd, consts.set, new Uint16Array([ws.rows, ws.cols, ws.cols * cell.width, ws.rows * cell.height])) === 0);
  return !!ok;
}
