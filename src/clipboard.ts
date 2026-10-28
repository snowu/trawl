/** A command that puts its stdin on the system clipboard, or null to fall back to the terminal (OSC 52). */
export function clipboardCommand(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  which: (bin: string) => string | null = Bun.which,
): string[] | null {
  if (platform === 'darwin' && which('pbcopy')) return ['pbcopy'];
  if (env.WAYLAND_DISPLAY && which('wl-copy')) return ['wl-copy'];
  if (env.DISPLAY && which('xclip')) return ['xclip', '-selection', 'clipboard'];
  if (env.DISPLAY && which('xsel')) return ['xsel', '--clipboard', '--input'];
  return null;
}

/** OSC 52 "set clipboard": the terminal itself copies, which also works over SSH. tmux needs it passed through. */
export function osc52(text: string, env: Record<string, string | undefined> = process.env): string {
  const seq = `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;
  return env.TMUX ? `\x1bPtmux;${seq.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : seq;
}

/** Copies text to the clipboard; returns how, for the status line. */
export async function copyText(text: string): Promise<string> {
  const cmd = clipboardCommand();
  if (cmd) {
    const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    proc.stdin.write(text);
    proc.stdin.end();
    if ((await proc.exited) === 0) return cmd[0];
  }
  process.stdout.write(osc52(text));
  return 'the terminal';
}
