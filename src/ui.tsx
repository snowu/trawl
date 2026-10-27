import { Box, render, Text, useApp, useInput, useWindowSize } from 'ink';
import { useMemo, useState } from 'react';
import { check } from './commands.ts';
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

/** How the picker closed: 'choose' asks the caller to pick folders with fzf and reopen. */
export type PickerResult = 'quit' | 'choose';

function Picker({ diagrams, viewer, onDone }: { diagrams: Diagram[]; viewer: Viewer; onDone: (r: PickerResult) => void }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [marked, setMarked] = useState<Set<Diagram>>(new Set());
  const [panX, setPanX] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);

  const filtered = useMemo(() => filterDiagrams(diagrams, query), [diagrams, query]);
  const problems = useMemo(() => new Map(check(diagrams).map((p) => [p.diagram, p])), [diagrams]);
  const current = filtered[Math.min(cursor, filtered.length - 1)];
  const bodyHeight = Math.max(3, rows - 4);
  const listWidth = Math.min(64, Math.floor(columns * 0.38));
  const previewWidth = columns - listWidth;

  const move = (delta: number) => {
    setCursor((c) => Math.max(0, Math.min(filtered.length - 1, c + delta)));
    setPanX(0);
    setStatus(null);
  };

  const open = (targets: Diagram[], how: Viewer) => {
    const broken = targets.filter((d) => problems.has(d));
    const ok = targets.filter((d) => !problems.has(d));
    if (broken.length) setStatus({ text: `skipped ${broken.length} broken: ${broken.map((d) => d.title).join(', ')}`, error: true });
    if (!ok.length) return;
    setStatus({ text: `rendering ${ok.length}…` });
    openDiagrams(
      ok.map((d) => d.source),
      how,
    ).then(
      () => setStatus({ text: `opened ${ok.length} in ${how}${broken.length ? `, skipped ${broken.length} broken` : ''}` }),
      (e) => setStatus({ text: e instanceof Error ? e.message.split('\n')[0] : String(e), error: true }),
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
    if (key.ctrl && input === 'f') {
      onDone('choose');
      return exit();
    }
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

  const problem = current && problems.get(current);
  const ascii = current && !showSource && !problem ? asciiPreview(current) : null;
  const previewBody = ascii ?? current?.source ?? '';
  const previewLines = previewBody.split('\n').slice(0, bodyHeight - (problem ? 7 : 2));

  const keys: [string, string][] = [
    ['enter', `open in ${viewer}`],
    ['ctrl-o', 'browser'],
    ['tab', 'mark'],
    ['ctrl-f', 'folders'],
    ['ctrl-t', showSource ? 'diagram' : 'source'],
    ['←/→', 'pan'],
    ['esc', query ? 'clear' : 'quit'],
  ];

  return (
    <Box flexDirection="column" height={rows - 1}>
      <Box paddingX={1}>
        <Text bold color="cyan">
          trawl{' '}
        </Text>
        <Text color="cyan">› </Text>
        <Text>{query}</Text>
        <Text color="cyan">▏</Text>
        <Text dimColor>
          {'  '}
          {filtered.length}/{diagrams.length}
          {problems.size ? ` · ${problems.size} broken` : ''}
          {marked.size ? ` · ${marked.size} marked` : ''}
        </Text>
      </Box>
      <Box height={bodyHeight + 2}>
        <Box flexDirection="column" width={listWidth} borderStyle="round" borderDimColor paddingRight={1}>
          {visible.map((d) => {
            const isCurrent = d === current;
            return (
              <Text key={`${d.file}:${d.line}`} wrap="truncate">
                <Text color="cyan">{isCurrent ? '▌' : ' '}</Text>
                {problems.has(d) ? <Text color="red">✗ </Text> : <Text color="yellow">{marked.has(d) ? '● ' : '  '}</Text>}
                <Text bold={isCurrent} color={isCurrent ? 'cyan' : undefined}>
                  {d.title}
                </Text>
                <Text color="magenta" dimColor={!isCurrent}>
                  {'  '}
                  {d.type ?? '?'}
                </Text>
                <Text dimColor>
                  {'  '}
                  {displayPath(d.file)}:{d.line}
                </Text>
              </Text>
            );
          })}
        </Box>
        <Box flexDirection="column" width={previewWidth} borderStyle="round" borderDimColor paddingX={1}>
          {current ? (
            <>
              <Text wrap="truncate">
                <Text bold>{current.title}</Text>
                <Text dimColor>
                  {'  '}
                  {current.type ?? '?'} · {displayPath(current.file)}:{current.line}
                  {!problem && !showSource && !ascii ? ' · no text preview for this type, enter to view' : ''}
                </Text>
              </Text>
              {problem ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text color="red" bold>
                    ✗ syntax error at line {problem.line}
                  </Text>
                  {problem.message
                    .split('\n')
                    .slice(0, 3)
                    .map((l, i) => (
                      <Text key={i} color="red" dimColor={i === 2} wrap="truncate">
                        {l}
                      </Text>
                    ))}
                </Box>
              ) : null}
              <Box flexDirection="column" marginTop={1}>
                {previewLines.map((line, i) => (
                  <Text key={i} wrap="truncate" dimColor={showSource || !!problem || !ascii}>
                    {line.trimEnd().slice(panX) || ' '}
                  </Text>
                ))}
              </Box>
            </>
          ) : (
            <Text dimColor>no diagram matches “{query}”</Text>
          )}
        </Box>
      </Box>
      <Text wrap="truncate">
        {' '}
        {status ? (
          <Text color={status.error ? 'red' : 'green'}>
            {status.text}
            {'   '}
          </Text>
        ) : null}
        {keys.map(([k, label], i) => (
          <Text key={k}>
            {i ? <Text dimColor> · </Text> : null}
            <Text>{k}</Text>
            <Text dimColor> {label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export async function runPicker(diagrams: Diagram[], viewer: Viewer): Promise<PickerResult> {
  let result: PickerResult = 'quit';
  // Alternate screen, like vim/less: often summoned from a keybind, so restore the terminal on exit.
  // Ink switches screens without homing the cursor, so a keybind fired mid-prompt would draw the first
  // row at the prompt's column: enter the alternate screen and home the cursor ourselves first.
  process.stdout.write('\x1b[?1049h\x1b[H');
  const app = render(<Picker diagrams={diagrams} viewer={viewer} onDone={(r) => (result = r)} />, {
    alternateScreen: true,
  });
  await app.waitUntilExit();
  return result;
}
