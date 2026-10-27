import { Box, render, Text, useApp, useInput, useWindowSize } from 'ink';
import { basename, dirname, relative } from 'node:path';
import { useEffect, useMemo, useState } from 'react';
import { check } from './commands.ts';
import { openDiagrams, type Viewer } from './open.ts';
import { clearImage, hideImage, imagesSupported, placeImage, transmitImage } from './kitty.ts';
import { renderToCache, toAscii } from './render.ts';
import { type Diagram, displayPath, tildePath } from './scan.ts';

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

/** Real rendered PNGs in the preview pane (Ghostty, kitty, WezTerm); colored ASCII elsewhere. */
const IMAGES = imagesSupported();

type Run = { text: string; kind: 'line' | 'arrow' | 'text' };
// Box drawing, the corner glyphs used for some node shapes, and diamonds; then arrowheads.
const LINE_CHARS = /[\u2500-\u257f\u2308-\u230f\u231c-\u231f\u25c6\u25c7]/;
const ARROW_CHARS = /[\u25b2\u25b6\u25b8\u25ba\u25bc\u25c0\u25c2\u25c4\u2190-\u2193]/;

/**
 * Splits a plain ASCII-art line into runs of box lines, arrowheads and label text, so the preview can color
 * them itself (the library's ANSI themes assume a light background and break truncation and panning).
 */
export function colorRuns(line: string): Run[] {
  const runs: Run[] = [];
  for (const ch of line) {
    const kind = ARROW_CHARS.test(ch) ? 'arrow' : LINE_CHARS.test(ch) ? 'line' : 'text';
    const last = runs.at(-1);
    if (last?.kind === kind) last.text += ch;
    else runs.push({ text: ch, kind });
  }
  return runs;
}

/** Box-drawing preview, or null when beautiful-mermaid can't draw this diagram type. */
function asciiPreview(diagram: Diagram): string | null {
  if (!asciiCache.has(diagram)) {
    try {
      // Subgraph boxes carry a `rect [rgb(...)]` caption from the source's styling: draw it as plain border.
      // HTML in labels (<b>, <br/>) is blanked to spaces of the same width so the boxes stay aligned.
      const art = toAscii(diagram.source)
        .replace(/rect \[rgb\([^)]*\)\]/g, (m) => '─'.repeat(m.length))
        .replace(/<\/?[a-z]+\s*\/?>/gi, (m) => ' '.repeat(m.length));
      asciiCache.set(diagram, art);
    } catch {
      asciiCache.set(diagram, null);
    }
  }
  return asciiCache.get(diagram)!;
}

/** How the picker closed: 'choose' asks the caller to pick folders with fzf and reopen. */
export type PickerResult = 'quit' | 'choose' | 'all';

type Row = { header: string } | { diagram: Diagram };

/**
 * A diagram's folder as a list header, relative to the scanned root that holds it: `docs/architecture/`.
 * With several roots it starts with the root's name, and the root itself shows as `name/`.
 */
export function folderLabel(file: string, roots: string[]): string {
  const dir = dirname(file);
  const root = roots.filter((r) => dir === r || dir.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  if (!root) return `${tildePath(dir)}/`;
  const rel = relative(root, dir);
  const prefix = roots.length > 1 || !rel ? `${basename(root)}/` : '';
  return `${prefix}${rel ? `${rel}/` : ''}`;
}

/** The list rows: diagrams grouped by folder, each group under a header. */
export function groupRows(diagrams: Diagram[], roots: string[]): Row[] {
  const labelled = diagrams.map((diagram) => ({ diagram, label: folderLabel(diagram.file, roots) }));
  // By folder path (a parent before its subfolders, so the root's own files come first), then file and line.
  const key = ({ diagram }: (typeof labelled)[number]) => `${dirname(diagram.file)}\0${diagram.file}`;
  // Plain comparison: localeCompare ignores '/' when collating, which scrambles path order.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  labelled.sort((a, b) => cmp(key(a), key(b)) || a.diagram.line - b.diagram.line);
  const rows: Row[] = [];
  let folder: string | undefined;
  for (const { diagram, label } of labelled) {
    if (label !== folder) rows.push({ header: (folder = label) });
    rows.push({ diagram });
  }
  return rows;
}

interface PickerProps {
  diagrams: Diagram[];
  /** The scanned folders, for the group headers. */
  roots: string[];
  viewer: Viewer;
  onDone: (r: PickerResult) => void;
}

function Picker({ diagrams, roots, viewer, onDone }: PickerProps) {
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
  // The cursor walks the grouped order shown on screen, not the scan order.
  const rowList = useMemo(() => groupRows(filtered, roots), [filtered, roots]);
  const ordered = useMemo(() => rowList.flatMap((r) => ('diagram' in r ? [r.diagram] : [])), [rowList]);
  const current = ordered[Math.min(cursor, ordered.length - 1)];
  // Frame is rows - 1 tall: header (1) + bordered body (bodyHeight + 2) + footer (1).
  const bodyHeight = Math.max(3, rows - 5);
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
    if (key.ctrl && (input === 'f' || input === 'a')) {
      onDone(input === 'f' ? 'choose' : 'all');
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

  // Keep the cursor's row inside the visible window of the (grouped) list.
  const currentRow = rowList.findIndex((r) => 'diagram' in r && r.diagram === current);
  const listStart = Math.max(0, Math.min(currentRow - Math.floor(bodyHeight / 2), rowList.length - bodyHeight));
  const visible = rowList.slice(listStart, listStart + bodyHeight);

  const problem = current && problems.get(current);
  const [imageError, setImageError] = useState<Diagram | null>(null);
  // A diagram whose PNG failed to render falls back to the ASCII preview.
  const imageMode = IMAGES && !!current && !problem && !showSource && imageError !== current;
  const ascii = current && !showSource && !problem && !imageMode ? asciiPreview(current) : null;

  // Image preview: render the PNG (cached) once the cursor rests, upload it, then place it after every redraw.
  const [image, setImage] = useState<{ diagram: Diagram; png: Uint8Array } | null>(null);
  useEffect(() => {
    if (!imageMode || !current) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const png = await Bun.file(await renderToCache(current.source, 'png')).bytes();
        if (!live) return;
        process.stdout.write(transmitImage(png));
        setImage({ diagram: current, png });
      } catch {
        if (live) setImageError(current);
      }
    }, 80);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [current, imageMode]);
  const shown = imageMode && image?.diagram === current ? image : null;
  // Pane interior below the title line and its margin; the last two rows are kept for the hint line and a gap.
  const imageBox = { row: 5, col: listWidth + 3, cols: previewWidth - 4, rows: bodyHeight - 4 };
  useEffect(() => {
    if (!IMAGES) return;
    // After Ink has written this frame: text redraws don't remove images, so place (or hide) explicitly.
    const timer = setTimeout(() => process.stdout.write(shown ? placeImage(shown.png, imageBox) : hideImage()), 30);
    return () => clearTimeout(timer);
  });
  const previewBody = ascii ?? current?.source ?? '';
  // Cut lines at the pane edge ourselves (no "…" column) and say when there's more to pan or scroll to.
  const artWidth = previewWidth - 4;
  const allLines = previewBody.split('\n').map((l) => l.trimEnd());
  const previewLines = allLines.slice(0, bodyHeight - (problem ? 7 : 3)).map((l) => l.slice(panX, panX + artWidth));
  const hiddenRight = Math.max(...allLines.map((l) => l.length)) > panX + artWidth;
  const hiddenBelow = allLines.length - previewLines.length;

  const keys: [string, string][] = [
    ['enter', `open in ${viewer}`],
    ['ctrl-o', 'browser'],
    ['tab', 'mark'],
    ['ctrl-f', 'subfolders'],
    ['ctrl-a', 'all folders'],
    ['ctrl-t', showSource ? 'diagram' : 'source'],
    ...(imageMode ? [] : [['←/→', 'pan'] as [string, string]]),
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
          {visible.map((row) => {
            if ('header' in row) {
              return (
                <Text key={`h:${row.header}`} bold color="blue" wrap="truncate-start">
                  {row.header}
                </Text>
              );
            }
            const d = row.diagram;
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
                  {basename(d.file)}:{d.line}
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
                  {!problem && !showSource && !imageMode && !ascii ? ' · no text preview for this type, enter to view' : ''}
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
              {imageMode ? (
                <Box flexDirection="column" marginTop={1} height={bodyHeight - 2} justifyContent="flex-end">
                  <Text dimColor>
                    {shown ? 'enter: open full size' : 'rendering…'}
                  </Text>
                </Box>
              ) : null}
              <Box flexDirection="column" marginTop={imageMode ? 0 : 1}>
                {!imageMode && previewLines.map((line, i) =>
                  ascii ? (
                    <Text key={i} wrap="truncate">
                      {colorRuns(line).map((run, j) =>
                        run.kind === 'text' ? (
                          <Text key={j}>{run.text}</Text>
                        ) : (
                          <Text key={j} color={run.kind === 'arrow' ? 'cyan' : 'gray'}>
                            {run.text}
                          </Text>
                        ),
                      )}
                      {line ? '' : ' '}
                    </Text>
                  ) : (
                    <Text key={i} wrap="truncate" dimColor>
                      {line || ' '}
                    </Text>
                  ),
                )}
                {!imageMode && (hiddenRight || hiddenBelow > 0 || panX > 0) ? (
                  <Text dimColor>
                    {[
                      panX > 0 && '← more',
                      hiddenRight && 'more →',
                      hiddenBelow > 0 && `${hiddenBelow} more lines (enter to open)`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                ) : null}
              </Box>
            </>
          ) : (
            <Text dimColor>
              {diagrams.length ? `no diagram matches “${query}”` : 'no mermaid diagrams here · ctrl-a: all your folders'}
            </Text>
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

export async function runPicker(diagrams: Diagram[], roots: string[], viewer: Viewer): Promise<PickerResult> {
  let result: PickerResult = 'quit';
  // Alternate screen, like vim/less: often summoned from a keybind, so restore the terminal on exit.
  // Ink switches screens without homing the cursor, so a keybind fired mid-prompt would draw the first
  // row at the prompt's column: enter the alternate screen and home the cursor ourselves first.
  process.stdout.write('\x1b[?1049h\x1b[H');
  const app = render(<Picker diagrams={diagrams} roots={roots} viewer={viewer} onDone={(r) => (result = r)} />, {
    alternateScreen: true,
  });
  await app.waitUntilExit();
  if (IMAGES) process.stdout.write(clearImage());
  return result;
}
