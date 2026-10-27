import { afterAll, beforeAll, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import { resolve } from 'node:path';

import { scan } from '../src/scan.ts';
import { Picker } from '../src/ui.tsx';

// Keep the escape sequences the picker writes (images, mouse mode) out of the test output.
const realWrite = process.stdout.write.bind(process.stdout);
beforeAll(() => {
  process.stdout.write = (() => true) as typeof process.stdout.write;
});
afterAll(() => {
  process.stdout.write = realWrite;
});

const root = resolve(import.meta.dir, '../examples');
const mouse = (code: number, col: number, row: number, end = 'M') => process.stdin.emit('data', `\x1b[<${code};${col};${row}${end}`);
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 5000) {
  for (const start = Date.now(); !check(); await tick()) if (Date.now() - start > ms) throw new Error('timed out');
}

test('mouse: wheel zooms the image, right-click resets, clicks select list rows; arrows jump folders', async () => {
  const diagrams = await scan([root]);
  const { lastFrame, stdin, unmount } = render(<Picker diagrams={diagrams} roots={[root]} viewer="feh" images onDone={() => {}} />);
  const frame = () => lastFrame() ?? '';
  try {
    await until(() => frame().includes('Tables') && !frame().includes('rendering…'));

    // ink-testing-library's terminal is 100 columns, so the list is 38 wide and the image starts at column 41.
    mouse(64, 70, 10);
    await until(() => frame().includes('1.3×'));
    mouse(64, 70, 10);
    await until(() => frame().includes('1.6×'));
    mouse(2, 70, 10);
    await until(() => !frame().includes('×'));

    // → moves to the next folder group's first diagram.
    const before = frame().split('\n').find((l) => l.includes('▌'));
    stdin.write('\x1b[C');
    await until(() => frame().split('\n').find((l) => l.includes('▌')) !== before);

    // Clicking the list's first row (a header) selects that folder's first diagram again.
    mouse(0, 5, 3);
    await until(() => frame().split('\n').find((l) => l.includes('▌')) === before);
  } catch (e) {
    realWrite(`\n--- last frame ---\n${frame()}\n`);
    throw e;
  } finally {
    unmount();
  }
}, 20000);
