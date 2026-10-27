import { Box, render, Text, useApp, useInput, useWindowSize } from 'ink';
import { useMemo, useState } from 'react';
import { openDiagrams, type Viewer } from './open.ts';
import { toAscii } from './render.ts';
import { type Diagram, displayPath } from './scan.ts';

const PAN_STEP = 8;

/** Every whitespace-separated term must appear in path, title or type (case-insensitive). */
export function filterDiagrams(diagrams: Diagram[], query: string): Diagram[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return diagrams;
  return diagrams.filter((d) => {
    const haystack = `${displayPath(d.file)} ${d.title} ${d.type ?? ''}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

const asciiCache = new Map<Diagram, string | null>();

/** Box-drawing preview, or null when beautiful-mermaid can't draw this diagram type. */
function asciiPreview(diagram: Diagram): string | null {
  if (!asciiCache.has(diagram)) {
    try {
      asciiCache.set(diagram, toAscii(diagram.source));
    } catch {
      asciiCache.set(diagram, null);
    }
  }
  return asciiCache.get(diagram)!;
}

function Picker({ diagrams, viewer }: { diagrams: Diagram[]; viewer: Viewer }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [marked, setMarked] = useState<Set<Diagram>>(new Set());
  const [panX, setPanX] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [status, setStatus] = useState('');

  const filtered = useMemo(() => filterDiagrams(diagrams, query), [diagrams, query]);
  const current = filtered[Math.min(cursor, filtered.length - 1)];
  const bodyHeight = Math.max(3, rows - 4);
  const listWidth = Math.min(60, Math.floor(columns * 0.4));
  const previewWidth = columns - listWidth - 3;

  const move = (delta: number) => {
    setCursor((c) => Math.max(0, Math.min(filtered.length - 1, c + delta)));
    setPanX(0);
  };

  const open = (targets: Diagram[], how: Viewer) => {
    if (!targets.length) return;
    setStatus(`rendering ${targets.length} diagram(s)…`);
    openDiagrams(
      targets.map((d) => d.source),
      how,
    ).then(
      () => setStatus(`opened ${targets.length} in ${how}`),
      (e) => setStatus(`error: ${e instanceof Error ? e.message.split('\n')[0] : e}`),
    );
  };

  useInput((input, key) => {
    if (key.escape && !query) return exit();
    if (key.escape) {
      setQuery('');
      return setCursor(0);
    }
    if (key.upArrow || (key.ctrl && input === 'p')) return move(-1);
    if (key.downArrow || (key.ctrl && input === 'n')) return move(1);
    if (key.pageUp) return move(-bodyHeight);
    if (key.pageDown) return move(bodyHeight);
    if (key.leftArrow) return setPanX((x) => Math.max(0, x - PAN_STEP));
    if (key.rightArrow) return setPanX((x) => x + PAN_STEP);
    if (key.ctrl && input === 't') return setShowSource((s) => !s);
    if (key.tab && current) {
      setMarked((m) => {
        const next = new Set(m);
        if (!next.delete(current)) next.add(current);
        return next;
      });
      return move(1);
    }
    if (key.return || (key.ctrl && input === 'o')) {
      const targets = marked.size ? [...marked] : current ? [current] : [];
      return open(targets, key.return ? viewer : 'browser');
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return setCursor(0);
    }
    // Fast repeats can arrive as one chunk ("\t\t") that Ink passes through as text; keep control chars out.
    const text = input.replace(/[\x00-\x1f\x7f]/g, '');
    if (text && !key.ctrl && !key.meta) {
      setQuery((q) => q + text);
      setCursor(0);
    }
  });

  // Keep the cursor row inside the visible window of the list.
  const listStart = Math.max(0, Math.min(cursor - Math.floor(bodyHeight / 2), filtered.length - bodyHeight));
  const visible = filtered.slice(listStart, listStart + bodyHeight);

  const ascii = current && !showSource ? asciiPreview(current) : null;
  const previewLines = (ascii ?? current?.source ?? '').split('\n').slice(0, bodyHeight);

  return (
    <Box flexDirection="column" height={rows - 1}>
      <Box>
        <Text color="cyan">{'> '}</Text>
        <Text>{query}</Text>
        <Text inverse> </Text>
        <Text dimColor>
          {'  '}
          {filtered.length}/{diagrams.length}
          {marked.size ? `  (${marked.size} marked)` : ''}
        </Text>
      </Box>
      <Box height={bodyHeight + 2}>
        <Box flexDirection="column" width={listWidth} borderStyle="round" borderDimColor>
          {visible.map((d) => {
            const isCurrent = d === current;
            return (
              <Text key={`${d.file}:${d.line}`} wrap="truncate" inverse={isCurrent}>
                <Text color="yellow">{marked.has(d) ? '● ' : '  '}</Text>
                <Text color="magenta">{(d.type ?? '?').padEnd(10)}</Text>
                {d.title}
                <Text dimColor>
                  {'  '}
                  {displayPath(d.file)}:{d.line}
                </Text>
              </Text>
            );
          })}
        </Box>
        <Box flexDirection="column" width={previewWidth} borderStyle="round" borderDimColor>
          {previewLines.map((line, i) => (
            <Text key={i} wrap="truncate">
              {line.trimEnd().slice(panX) || ' '}
            </Text>
          ))}
        </Box>
      </Box>
      <Text dimColor wrap="truncate">
        {status ? <Text color="green">{status} · </Text> : null}
        enter: open in {viewer} · ctrl-o: browser · tab: mark · ←/→: pan · ctrl-t: {showSource ? 'diagram' : 'source'}{' '}
        · esc: clear/quit
        {current && !showSource && !ascii ? ' · (no text preview for this type)' : ''}
      </Text>
    </Box>
  );
}

export async function runPicker(diagrams: Diagram[], viewer: Viewer): Promise<void> {
  // Alternate screen, like vim/less: often summoned from a keybind, so restore the terminal on exit.
  // Ink switches screens without homing the cursor, so a keybind fired mid-prompt would draw the first
  // row at the prompt's column: enter the alternate screen and home the cursor ourselves first.
  process.stdout.write('\x1b[?1049h\x1b[H');
  const app = render(<Picker diagrams={diagrams} viewer={viewer} />, { alternateScreen: true });
  await app.waitUntilExit();
}
