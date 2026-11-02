import { detectType } from 'pele';

export interface Diagram {
  /** Absolute path of the file holding the diagram. */
  file: string;
  /** 1-based line of the diagram's first source line. */
  line: number;
  /** Nearest markdown heading above the fence, or the file name for .mmd files. */
  title: string;
  /** Diagram kind as detected by pele (flowchart, sequence, ...), or null when unknown. */
  type: string | null;
  source: string;
  /**
   * Stable within its file: an explicit `id=...` on the fence or a `%% trawl:id ...` line in the source,
   * else derived from the heading (`-2`, `-3` for repeats). `file#id` names it across files.
   */
  id: string;
  /** True when the id was written in the file, so it survives the heading being renamed. */
  explicitId: boolean;
}

export interface Section {
  /** 1-based line of the heading (1 and level 0 for the text before the first heading). */
  line: number;
  /** 0 for the preamble, else 1-6. */
  level: number;
  heading: string;
  /** Headings from the top down to this one, joined with ' › '. */
  crumb: string;
  /** Section text below the heading, up to the next heading of any level. */
  body: string;
}

export interface Doc {
  file: string;
  /** Frontmatter `title`, else the first H1, else the file name without extension. */
  title: string;
  frontmatter: Record<string, string>;
  sections: Section[];
  diagrams: Diagram[];
  /** Targets of relative markdown links ([x](other.md#a)), as written. */
  links: string[];
}

const FENCE_OPEN = /^\s*(```+|~~~+)\s*([\w-]*)(.*)$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const ID_COMMENT = /^\s*%%\s*trawl:id\s+([\w.-]+)\s*$/m;
const ID_ATTR = /\bid=["']?([\w.-]+)/;
const LINK = /\]\(([^)\s#]+\.(?:md|mmd))(?:#[^)\s]*)?\)/g;

/** `Order Lifecycle (v2)` -> `order-lifecycle-v2` */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'diagram'
  );
}

/** Flat `key: value` frontmatter (enough for title/tags/owner); nested YAML is kept as raw text. */
function parseFrontmatter(lines: string[]): { data: Record<string, string>; end: number } {
  if (lines[0]?.trim() !== '---') return { data: {}, end: 0 };
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (close < 0) return { data: {}, end: 0 };
  const data: Record<string, string> = {};
  for (const l of lines.slice(1, close)) {
    const m = /^([\w-]+)\s*:\s*(.*)$/.exec(l);
    if (m) data[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { data, end: close + 1 };
}

/** Assigns ids, numbering repeats of the same derived id within one file. */
function assignIds(diagrams: Omit<Diagram, 'id' | 'explicitId'>[], explicit: (string | null)[]): Diagram[] {
  const taken = new Set(explicit.filter((x): x is string => x !== null));
  const counts = new Map<string, number>();
  return diagrams.map((d, i) => {
    if (explicit[i]) return { ...d, id: explicit[i]!, explicitId: true };
    const base = slug(d.title);
    let n = counts.get(base) ?? 0;
    let id: string;
    do {
      n++;
      id = n === 1 ? base : `${base}-${n}`;
    } while (taken.has(id));
    counts.set(base, n);
    taken.add(id);
    return { ...d, id, explicitId: false };
  });
}

/** Parses a markdown or .mmd file into sections and diagrams. Headings inside code fences are ignored. */
export function parseDoc(file: string, text: string): Doc {
  const name = file.split('/').pop() ?? file;
  if (file.endsWith('.mmd')) {
    const title = name.replace(/\.mmd$/, '');
    const explicit = ID_COMMENT.exec(text)?.[1] ?? null;
    const diagrams = assignIds([{ file, line: 1, title, type: detectType(text), source: text }], [explicit]);
    return {
      file,
      title,
      frontmatter: {},
      sections: [{ line: 1, level: 0, heading: title, crumb: title, body: text }],
      diagrams,
      links: [],
    };
  }

  const lines = text.split('\n');
  const { data: frontmatter, end: bodyStart } = parseFrontmatter(lines);
  const raw: Omit<Diagram, 'id' | 'explicitId'>[] = [];
  const explicit: (string | null)[] = [];
  const sections: Section[] = [];
  const stack: string[] = [];
  let current: Section = { line: bodyStart + 1, level: 0, heading: name, crumb: name, body: '' };
  let bodyLines: string[] = [];
  let firstH1: string | undefined;

  const flush = () => {
    current.body = bodyLines.join('\n').trim();
    if (current.level > 0 || current.body) sections.push(current);
    bodyLines = [];
  };

  for (let i = bodyStart; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (open) {
      const fence = open[1];
      let end = i + 1;
      while (end < lines.length && !lines[end].trimStart().startsWith(fence)) end++;
      if (open[2] === 'mermaid') {
        const source = lines.slice(i + 1, end).join('\n');
        raw.push({ file, line: i + 2, title: current.level ? current.heading : name, type: detectType(source), source });
        explicit.push(ID_ATTR.exec(open[3])?.[1] ?? ID_COMMENT.exec(source)?.[1] ?? null);
      }
      bodyLines.push(...lines.slice(i, end + 1));
      i = end;
      continue;
    }
    const h = HEADING.exec(lines[i]);
    if (!h) {
      bodyLines.push(lines[i]);
      continue;
    }
    flush();
    const level = h[1].length;
    const heading = h[2];
    if (level === 1) firstH1 ??= heading;
    stack.length = level - 1;
    stack[level - 1] = heading;
    current = { line: i + 1, level, heading, crumb: stack.filter(Boolean).join(' › '), body: '' };
  }
  flush();

  const links = [...new Set([...text.matchAll(LINK)].map((m) => m[1]).filter((l) => !/^[a-z]+:/i.test(l)))];
  return {
    file,
    title: frontmatter.title || firstH1 || name.replace(/\.(md|mmd)$/, ''),
    frontmatter,
    sections,
    diagrams: assignIds(raw, explicit),
    links,
  };
}

/** The section containing `line` (1-based): the last one starting at or above it. */
export function sectionAt(doc: Doc, line: number): Section | undefined {
  return doc.sections.filter((s) => s.line <= line).at(-1) ?? doc.sections[0];
}

/**
 * Replaces one diagram's source in its file's text, keeping the fence and everything around it.
 * The diagram is located by its current line and must still hold `expected` there (no stale writes).
 */
export function replaceDiagramSource(text: string, diagram: Diagram, next: string): string {
  if (diagram.file.endsWith('.mmd')) return next.endsWith('\n') ? next : `${next}\n`;
  const lines = text.split('\n');
  const start = diagram.line - 1;
  const count = diagram.source === '' ? 0 : diagram.source.split('\n').length;
  if (lines.slice(start, start + count).join('\n') !== diagram.source) {
    throw new Error(`${diagram.file}:${diagram.line} changed since it was read; re-read the diagram and retry`);
  }
  const body = next.replace(/\n+$/, '');
  lines.splice(start, count, ...(body ? body.split('\n') : []));
  return lines.join('\n');
}
