import { expandHome } from './config.ts';
import { type Diagram, type Doc, parseDoc, type Section, sectionAt, slug } from './markdown.ts';

/** `docs/a.md:40`, `~/notes/b.md#checkout-flow`, or a bare path. */
export interface Ref {
  file: string;
  line?: number;
  anchor?: string;
}

export function parseRef(ref: string): Ref {
  const m = /^(.*?)(?::(\d+)|#([\w.-]+))?$/.exec(ref.trim())!;
  return { file: expandHome(m[1]), line: m[2] ? Number(m[2]) : undefined, anchor: m[3] };
}

export async function loadDoc(file: string): Promise<Doc> {
  const f = Bun.file(file);
  if (!(await f.exists())) throw new Error(`no such file: ${file}`);
  if (!/\.(md|mmd)$/.test(file)) throw new Error(`not a markdown or .mmd file: ${file}`);
  return parseDoc(file, await f.text());
}

/** The section a ref points at: by line, by heading slug (or a diagram id inside it), else undefined for "whole file". */
export function findSection(doc: Doc, ref: Ref): Section | undefined {
  if (ref.line !== undefined) return sectionAt(doc, ref.line);
  if (ref.anchor) {
    const bySlug = doc.sections.find((s) => slug(s.heading) === ref.anchor);
    if (bySlug) return bySlug;
    const d = doc.diagrams.find((x) => x.id === ref.anchor);
    if (d) return sectionAt(doc, d.line);
    throw new Error(`${ref.file}: no heading or diagram "${ref.anchor}"`);
  }
  return undefined;
}

/** The diagram a ref points at: `#id`, the one at/above `:line`, or the only one in the file. */
export function findDiagram(doc: Doc, ref: Ref): Diagram {
  if (ref.anchor) {
    const d = doc.diagrams.find((x) => x.id === ref.anchor);
    if (!d) {
      const ids = doc.diagrams.map((x) => x.id).join(', ') || 'none';
      throw new Error(`${ref.file}: no diagram with id "${ref.anchor}" (ids: ${ids})`);
    }
    return d;
  }
  if (ref.line !== undefined) {
    const d = doc.diagrams.filter((x) => x.line - 1 <= ref.line!).at(-1);
    if (!d) throw new Error(`${ref.file}: no diagram at or above line ${ref.line}`);
    return d;
  }
  if (doc.diagrams.length === 1) return doc.diagrams[0];
  throw new Error(
    doc.diagrams.length
      ? `${ref.file} has ${doc.diagrams.length} diagrams; add #id (${doc.diagrams.map((x) => x.id).join(', ')})`
      : `${ref.file}: no mermaid diagrams`,
  );
}

/** A section as markdown: its heading line (at its level) and body. */
export function sectionText(s: Section): string {
  return s.level ? `${'#'.repeat(s.level)} ${s.heading}\n\n${s.body}` : s.body;
}
