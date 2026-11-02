// Markdown for a terminal preview pane: headings, lists, quotes, code and tables styled with ANSI, search words
// highlighted, Mermaid fences handed to a callback (image or box art). Not a full CommonMark renderer: it is for
// reading a section at a glance in fzf's preview.

const A = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  under: '\x1b[4m',
  h1: '\x1b[1;38;5;80m',
  h2: '\x1b[1;38;5;114m',
  h3: '\x1b[1;38;5;179m',
  code: '\x1b[38;5;180m',
  mark: '\x1b[1;30;43m',
};

export interface TermMdOptions {
  /** Words to highlight (the search query). */
  query?: string;
  /** Draws a Mermaid fence: an image escape sequence or box art, plus anything to say about it. */
  diagram?: (source: string) => string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Highlights each query word (prefix match, case-insensitive) in plain text, restoring `restore` after. */
export function highlight(text: string, query: string | undefined, restore = ''): string {
  const words = (query ?? '').match(/[\p{L}\p{N}_]{2,}/gu);
  if (!words) return text;
  const re = new RegExp(`(${words.map(escapeRe).join('|')})[\\p{L}\\p{N}_]*`, 'giu');
  return text.replace(re, (m) => `${A.mark}${m}${A.reset}${restore}`);
}

/** Inline markdown: **bold**, *italic*, `code`, [links](url), ![images](url). */
function inline(text: string, query: string | undefined, base = ''): string {
  const parts: string[] = [];
  // Split out code spans first so nothing inside them is styled.
  const re = /(`+)([^`]+?)\1/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(styleText(text.slice(last, m.index), query, base));
    parts.push(`${A.code}${m[2]}${A.reset}${base}`);
    last = m.index! + m[0].length;
  }
  parts.push(styleText(text.slice(last), query, base));
  return parts.join('');
}

function styleText(text: string, query: string | undefined, base: string): string {
  return highlight(
    text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => `[image${alt ? `: ${alt}` : ''}]`)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, (_, t) => `${A.under}${t}${A.reset}${base}`)
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `${A.bold}${a ?? b}${A.reset}${base}`)
      .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)|(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}${A.italic}${a ?? b}${A.reset}${base}`),
    query,
    base,
  );
}

/** Renders markdown for the preview pane. */
export function renderTermMd(md: string, opts: TermMdOptions = {}): string {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w-]*)/.exec(line);
    if (fence) {
      let end = i + 1;
      while (end < lines.length && !lines[end].trimStart().startsWith(fence[1])) end++;
      const body = lines.slice(i + 1, end);
      if (fence[2] === 'mermaid' && opts.diagram) out.push(opts.diagram(body.join('\n')));
      else {
        if (fence[2]) out.push(`${A.dim}╭─ ${fence[2]}${A.reset}`);
        for (const b of body) out.push(`${A.dim}│${A.reset} ${A.code}${b}${A.reset}`);
        out.push(`${A.dim}╰─${A.reset}`);
      }
      i = end;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      const color = level === 1 ? A.h1 : level === 2 ? A.h2 : A.h3;
      if (out.length && out.at(-1) !== '') out.push('');
      out.push(`${color}${level > 2 ? `${'·'.repeat(level - 2)} ` : ''}${highlight(h[2], opts.query, color)}${A.reset}`);
      if (level === 1) out.push(`${A.dim}${'─'.repeat(Math.min(60, [...h[2]].length))}${A.reset}`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(`${A.dim}${'─'.repeat(40)}${A.reset}`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`${A.dim}▎${A.reset} ${A.italic}${inline(quote[1], opts.query, A.italic)}${A.reset}`);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (item) {
      const bullet = /\d/.test(item[2]) ? item[2] : item[1].length >= 2 ? '◦' : '•';
      const box = item[3] ? (/x/i.test(item[3]) ? '☑ ' : '☐ ') : '';
      out.push(`${item[1]}${A.dim}${bullet}${A.reset} ${box}${inline(item[4], opts.query)}`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // the |---|---| separator row
      const cells = line.trim().slice(1, -1).split('|').map((c) => inline(c.trim(), opts.query));
      out.push(`${A.dim}│${A.reset} ${cells.join(` ${A.dim}│${A.reset} `)}`);
      continue;
    }
    out.push(inline(line, opts.query));
  }
  // No runs of blank lines.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
