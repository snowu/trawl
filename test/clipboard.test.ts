import { describe, expect, test } from 'bun:test';
import { clipboardCommand, osc52 } from '../src/clipboard.ts';

const has = (...bins: string[]) => (bin: string) => (bins.includes(bin) ? `/usr/bin/${bin}` : null);

describe('clipboardCommand', () => {
  test('picks the tool for the session', () => {
    expect(clipboardCommand({}, 'darwin', has('pbcopy'))).toEqual(['pbcopy']);
    expect(clipboardCommand({ WAYLAND_DISPLAY: 'wayland-1' }, 'linux', has('wl-copy', 'xclip'))).toEqual(['wl-copy']);
    expect(clipboardCommand({ DISPLAY: ':0' }, 'linux', has('xsel'))).toEqual(['xsel', '--clipboard', '--input']);
  });

  test('falls back to the terminal over SSH or without tools', () => {
    expect(clipboardCommand({}, 'linux', has('wl-copy', 'xclip'))).toBeNull();
    expect(clipboardCommand({ WAYLAND_DISPLAY: 'wayland-1' }, 'linux', has())).toBeNull();
  });
});

describe('osc52', () => {
  test('base64 payload, wrapped for tmux', () => {
    expect(osc52('a --> b', {})).toBe(`\x1b]52;c;${btoa('a --> b')}\x07`);
    expect(osc52('x', { TMUX: '1' })).toBe(`\x1bPtmux;\x1b\x1b]52;c;${btoa('x')}\x07\x1b\\`);
  });
});
