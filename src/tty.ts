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

let libc: ReturnType<typeof openLibc> | undefined;
function openLibc(name: string) {
  return dlopen(name, { ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 } });
}

function withTty<T>(fn: (fd: number, ioctl: (fd: number, req: number, buf: Uint16Array) => number) => T): T | null {
  const consts = IOCTL[process.platform as keyof typeof IOCTL];
  if (!consts) return null;
  let fd = -1;
  try {
    const lib = (libc ??= openLibc(consts.libc));
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
 * Writes cols x rows cells of `cell` pixels into the winsize record, replacing whatever is there: ConPTY can report a
 * pixel size that doesn't match the real cells, and fzf trusts it. `cell` should be measured (CSI 16 t). True when
 * the record now holds that size.
 */
export function setPixelSize(cell: { width: number; height: number }): boolean {
  const consts = IOCTL[process.platform as keyof typeof IOCTL];
  const ws = getWinsize();
  if (!ws || !consts || !ws.rows || !ws.cols) return false;
  const want = { xpixel: ws.cols * cell.width, ypixel: ws.rows * cell.height };
  if (ws.xpixel === want.xpixel && ws.ypixel === want.ypixel) return true;
  const ok = withTty((fd, ioctl) => ioctl(fd, consts.set, new Uint16Array([ws.rows, ws.cols, want.xpixel, want.ypixel])) === 0);
  return !!ok;
}

/** Cell size in pixels as the winsize record has it (what fzf will assume), or null when it doesn't say. */
export function recordedCell(): { width: number; height: number } | null {
  const ws = getWinsize();
  if (!ws || !ws.rows || !ws.cols || !ws.xpixel || !ws.ypixel) return null;
  return { width: ws.xpixel / ws.cols, height: ws.ypixel / ws.rows };
}

/**
 * Keeps the pixel size in the winsize record while a child (fzf) runs: something (WSL's ConPTY bridge, a terminal
 * resize) can reset it to 0, and fzf then draws placeholder boxes for images. Rewriting it also makes the kernel send
 * SIGWINCH, so fzf reads the size again and redraws. Returns a stop function.
 */
export function keepPixelSize(cell: { width: number; height: number }, onFix?: (from: Winsize) => void, everyMs = 250): () => void {
  const timer = setInterval(() => {
    const ws = getWinsize();
    if (!ws || !ws.rows || !ws.cols) return;
    if (ws.xpixel === ws.cols * cell.width && ws.ypixel === ws.rows * cell.height) return;
    onFix?.(ws);
    setPixelSize(cell);
  }, everyMs);
  return () => clearInterval(timer);
}
