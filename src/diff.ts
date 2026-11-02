import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { check } from './commands.ts';
import { type Diagram, parseDoc } from './markdown.ts';
import { svgToPng, toSvg } from './render.ts';

export interface Change {
  status: 'added' | 'removed' | 'changed';
  /** Repo-relative path (the new path for renames). */
  file: string;
  id: string;
  title: string;
  /** Line in the new file (old file for removals). */
  line: number;
  before?: string;
  after?: string;
  /** Set by renderChanges: PNG file names in the output folder, or the syntax error instead. */
  beforePng?: string;
  afterPng?: string;
  beforeError?: string;
  afterError?: string;
}

const MARKER = '<!-- trawl-diagram-diff -->';

function git(cwd: string, args: string[]): string | null {
  const r = Bun.spawnSync(['git', ...args], { cwd, stderr: 'ignore' });
  return r.success ? r.stdout.toString() : null;
}

function gitOrThrow(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd });
  if (!r.success) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

const isDiagramFile = (p: string) => /\.(md|mmd)$/.test(p);

/** Pairs of (old path, new path) for markdown files that differ; null on the side where the file doesn't exist. */
function changedFiles(root: string, base: string, head?: string): [string | null, string | null][] {
  const args = ['diff', '--name-status', '-M', '-z', base, ...(head ? [head] : []), '--'];
  const out = gitOrThrow(root, args).split('\0').filter(Boolean);
  const pairs: [string | null, string | null][] = [];
  for (let i = 0; i < out.length; ) {
    const status = out[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = out[i++], to = out[i++];
      if (isDiagramFile(from) || isDiagramFile(to)) pairs.push([status.startsWith('C') ? null : from, to]);
    } else {
      const p = out[i++];
      if (!isDiagramFile(p)) continue;
      pairs.push(status === 'A' ? [null, p] : status === 'D' ? [p, null] : [p, p]);
    }
  }
  if (!head) {
    // Untracked files only show up in the working tree.
    for (const p of (git(root, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '').split('\0')) {
      if (p && isDiagramFile(p) && !pairs.some(([, n]) => n === p)) pairs.push([null, p]);
    }
  }
  return pairs;
}

/**
 * Diagrams added, removed or changed between BASE and HEAD (or the working tree), PR style: compared from the merge
 * base, so changes on the base branch since don't show up. Diagrams are matched by id within their file.
 */
export async function diagramDiff(root: string, base: string, head?: string): Promise<Change[]> {
  const mergeBase = git(root, ['merge-base', base, head ?? 'HEAD'])?.trim() || base;
  const changes: Change[] = [];
  for (const [from, to] of changedFiles(root, mergeBase, head)) {
    const beforeText = from ? git(root, ['show', `${mergeBase}:${from}`]) : null;
    const afterText = to ? (head ? git(root, ['show', `${head}:${to}`]) : await Bun.file(join(root, to)).text().catch(() => null)) : null;
    const before = beforeText === null ? [] : parseDoc(join(root, from!), beforeText).diagrams;
    const after = afterText === null ? [] : parseDoc(join(root, to!), afterText).diagrams;
    const old = new Map(before.map((d) => [d.id, d]));
    for (const d of after) {
      const prev = old.get(d.id);
      old.delete(d.id);
      if (!prev) changes.push({ status: 'added', file: to!, id: d.id, title: d.title, line: d.line, after: d.source });
      else if (prev.source.trim() !== d.source.trim())
        changes.push({ status: 'changed', file: to!, id: d.id, title: d.title, line: d.line, before: prev.source, after: d.source });
    }
    for (const d of old.values()) changes.push({ status: 'removed', file: from!, id: d.id, title: d.title, line: d.line, before: d.source });
  }
  return changes;
}

/** `changed  docs/a.md#flow  Flow`, one line per change. */
export function formatChanges(changes: Change[]): string {
  if (!changes.length) return 'No diagram changes.';
  return changes.map((c) => `${c.status.padEnd(8)}${c.file}#${c.id}\t${c.title}`).join('\n');
}

const fileStem = (c: Change) => `${c.file.replaceAll('/', '__')}--${c.id}`;

function parses(source: string): string | undefined {
  const p = check([{ file: '', line: 1, title: '', type: null, source, id: '', explicitId: false } as Diagram])[0];
  return p?.message.split('\n')[0];
}

/** Renders each change's before/after to PNGs in `out` and records the file names (or syntax errors). */
export async function renderChanges(changes: Change[], out: string): Promise<void> {
  await mkdir(out, { recursive: true });
  for (const c of changes) {
    for (const side of ['before', 'after'] as const) {
      const source = c[side];
      if (source === undefined) continue;
      const error = parses(source);
      if (error) {
        c[`${side}Error`] = error;
        continue;
      }
      const name = `${fileStem(c)}-${side}.png`;
      await Bun.write(join(out, name), await svgToPng(toSvg(source)));
      c[`${side}Png`] = name;
    }
  }
}

/** Minimal line diff (LCS) as unified-style `+`/`-`/` ` lines; fine for diagram-sized inputs. */
export function lineDiff(a: string, b: string): string {
  const x = a.split('\n'), y = b.split('\n');
  if (x.length * y.length > 250_000) return b.split('\n').map((l) => `+${l}`).join('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (out.push(` ${x[i]}`), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`-${x[i++]}`);
    else out.push(`+${y[j++]}`);
  }
  while (i < x.length) out.push(`-${x[i++]}`);
  while (j < y.length) out.push(`+${y[j++]}`);
  return out.join('\n');
}

/**
 * The PR comment: one block per changed diagram with before/after images (when `imageUrl` says where the rendered
 * PNGs are served) and the Mermaid diff. Starts with a marker so CI can update its previous comment.
 */
export function prComment(changes: Change[], opts: { imageUrl?: string; siteUrl?: string } = {}): string {
  if (!changes.length) return `${MARKER}\n### Diagrams\n\nNo diagram changes in this PR.\n`;
  const base = opts.imageUrl?.replace(/\/+$/, '');
  const img = (name: string | undefined, error: string | undefined, alt: string) =>
    error ? `⚠️ doesn't parse: \`${error.replaceAll('`', "'")}\`` : name && base ? `<img src="${base}/${encodeURIComponent(name)}" alt="${alt}" width="420">` : '';
  const icon = { added: '🟢 added', removed: '🔴 removed', changed: '🟡 changed' };
  const parts = [MARKER, `### Diagrams changed in this PR (${changes.length})`, ''];
  for (const c of changes) {
    parts.push(`#### ${icon[c.status]}: ${c.title} · \`${c.file}#${c.id}\``, '');
    const before = img(c.beforePng, c.beforeError, 'before');
    const after = img(c.afterPng, c.afterError, 'after');
    if (c.status === 'changed' && (before || after)) parts.push('| Before | After |', '|---|---|', `| ${before} | ${after} |`, '');
    else if (c.status !== 'changed' && (before || after)) parts.push(c.status === 'added' ? after : before, '');
    const diff = c.status === 'changed' ? lineDiff(c.before!, c.after!) : (c.after ?? c.before ?? '').split('\n').map((l) => `${c.status === 'added' ? '+' : '-'}${l}`).join('\n');
    parts.push('<details><summary>Mermaid</summary>', '', '```diff', diff.replaceAll('```', "'''"), '```', '</details>', '');
  }
  if (opts.siteUrl) parts.push(`[Browse all docs and diagrams](${opts.siteUrl})`);
  return parts.join('\n');
}
