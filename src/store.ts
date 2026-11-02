import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type Diagram, parseDoc } from './markdown.ts';
import { findMarkdown } from './scan.ts';

/** Bump when parsing changes, so old indexes are rebuilt instead of serving stale rows. */
const SCHEMA = 2;

export const INDEX_PATH =
  process.env.TRAWL_INDEX || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'trawl', 'index.db');

export interface Hit {
  file: string;
  line: number;
  level: number;
  heading: string;
  crumb: string;
  docTitle: string;
  /** Matching text with the matched words wrapped in `mark` (default « »). */
  snippet: string;
}

export interface RefreshStats {
  files: number;
  updated: number;
  removed: number;
}

/** True when `path` is `root` or inside it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * Turns what someone types into a safe FTS5 query: each word becomes a quoted prefix term (all must match), so
 * punctuation in the input (`a.md`, `foo-bar`, `"`) can't be read as query syntax.
 */
export function ftsQuery(input: string): string {
  const words = input.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.map((w) => `"${w}"*`).join(' ');
}

/**
 * An on-disk index of every markdown/.mmd file under the folders it is refreshed with: documents, sections
 * (full-text searchable) and diagrams. Refreshing re-reads only files whose size or mtime changed.
 */
export class Store {
  readonly db: Database;

  constructor(path = INDEX_PATH) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA busy_timeout = 3000');
    const version = (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version !== SCHEMA) this.reset();
  }

  private reset(): void {
    this.db.run('DROP TABLE IF EXISTS files');
    this.db.run('DROP TABLE IF EXISTS sections');
    this.db.run('DROP TABLE IF EXISTS sections_fts');
    this.db.run('DROP TABLE IF EXISTS diagrams');
    this.db.run('CREATE TABLE files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER, title TEXT, frontmatter TEXT, links TEXT)');
    this.db.run('CREATE TABLE sections (id INTEGER PRIMARY KEY, path TEXT, line INTEGER, level INTEGER, heading TEXT, crumb TEXT, body TEXT)');
    this.db.run('CREATE INDEX sections_path ON sections(path)');
    this.db.run("CREATE VIRTUAL TABLE sections_fts USING fts5(heading, crumb, body, tokenize='porter unicode61')");
    this.db.run('CREATE TABLE diagrams (path TEXT, line INTEGER, id TEXT, explicit INTEGER, title TEXT, type TEXT, source TEXT)');
    this.db.run('CREATE INDEX diagrams_path ON diagrams(path)');
    this.db.run(`PRAGMA user_version = ${SCHEMA}`);
  }

  close(): void {
    this.db.close();
  }

  private removeFile(path: string): void {
    const ids = this.db.query('SELECT id FROM sections WHERE path = ?').all(path) as { id: number }[];
    const del = this.db.prepare('DELETE FROM sections_fts WHERE rowid = ?');
    for (const { id } of ids) del.run(id);
    this.db.run('DELETE FROM sections WHERE path = ?', [path]);
    this.db.run('DELETE FROM diagrams WHERE path = ?', [path]);
    this.db.run('DELETE FROM files WHERE path = ?', [path]);
  }

  private writeFile(path: string, mtime: number, size: number, text: string): void {
    const doc = parseDoc(path, text);
    this.removeFile(path);
    this.db.run('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)', [
      path,
      mtime,
      size,
      doc.title,
      JSON.stringify(doc.frontmatter),
      JSON.stringify(doc.links),
    ]);
    const sec = this.db.prepare('INSERT INTO sections (path, line, level, heading, crumb, body) VALUES (?, ?, ?, ?, ?, ?) RETURNING id');
    const fts = this.db.prepare('INSERT INTO sections_fts (rowid, heading, crumb, body) VALUES (?, ?, ?, ?)');
    for (const s of doc.sections) {
      const { id } = sec.get(path, s.line, s.level, s.heading, s.crumb, s.body) as { id: number };
      fts.run(id, s.heading, s.crumb, s.body);
    }
    const dia = this.db.prepare('INSERT INTO diagrams VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const d of doc.diagrams) dia.run(path, d.line, d.id, d.explicitId ? 1 : 0, d.title, d.type, d.source);
  }

  /** Brings the index up to date for these folders/files: (re)reads changed files, drops deleted ones. */
  async refresh(paths: string[]): Promise<RefreshStats> {
    const roots = paths.map((p) => resolve(p));
    const found: string[] = [];
    for (const root of roots) {
      if (/\.(md|mmd)$/.test(root)) found.push(root);
      else found.push(...(await findMarkdown(root)));
    }
    const files = [...new Set(found)];
    const known = new Map(
      (this.db.query('SELECT path, mtime, size FROM files').all() as { path: string; mtime: number; size: number }[])
        .filter((f) => roots.some((r) => within(f.path, r)))
        .map((f) => [f.path, f]),
    );

    const stats = await Promise.all(files.map((f) => stat(f).catch(() => null)));
    const changed = files.flatMap((f, i) => {
      const s = stats[i];
      if (!s) return [];
      const k = known.get(f);
      return k && k.mtime === s.mtimeMs && k.size === s.size ? [] : [{ path: f, mtime: s.mtimeMs, size: s.size }];
    });
    const texts = await Promise.all(changed.map((c) => Bun.file(c.path).text().catch(() => null)));

    const present = new Set(files);
    const gone = [...known.keys()].filter((p) => !present.has(p));
    this.db.transaction(() => {
      changed.forEach((c, i) => {
        const text = texts[i];
        if (text === null) this.removeFile(c.path);
        else this.writeFile(c.path, c.mtime, c.size, text);
      });
      gone.forEach((p) => this.removeFile(p));
    })();
    return { files: files.length, updated: changed.length, removed: gone.length };
  }

  /** Full-text search over section headings and text, best matches first. Headings weigh most. */
  search(query: string, opts: { roots?: string[]; limit?: number; mark?: [string, string] } = {}): Hit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const [open, close] = opts.mark ?? ['«', '»'];
    const roots = (opts.roots ?? []).map((r) => resolve(r));
    const where = roots.length ? `AND (${roots.map(() => "s.path = ? OR s.path LIKE ? ESCAPE '\\'").join(' OR ')})` : '';
    const likeArgs = roots.flatMap((r) => [r, `${r.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`]);
    const rows = this.db
      .query(
        `SELECT s.path AS file, s.line, s.level, s.heading, s.crumb, f.title AS docTitle,
                snippet(sections_fts, 2, ?, ?, '…', 12) AS snippet
         FROM sections_fts JOIN sections s ON s.id = sections_fts.rowid JOIN files f ON f.path = s.path
         WHERE sections_fts MATCH ? ${where}
         ORDER BY bm25(sections_fts, 8.0, 3.0, 1.0)
         LIMIT ?`,
      )
      .all(open, close, match, ...likeArgs, opts.limit ?? 50) as Hit[];
    return rows.map((r) => ({ ...r, snippet: r.snippet.replace(/\s+/g, ' ').trim() }));
  }

  /** Most recently modified documents under these roots, as hits on their first section. */
  recent(opts: { roots?: string[]; limit?: number } = {}): Hit[] {
    const abs = (opts.roots ?? []).map((r) => resolve(r));
    const files = (this.db.query('SELECT path, title FROM files ORDER BY mtime DESC').all() as { path: string; title: string }[])
      .filter((f) => !abs.length || abs.some((root) => within(f.path, root)))
      .slice(0, opts.limit ?? 50);
    const first = this.db.prepare('SELECT line, level, heading, crumb, body FROM sections WHERE path = ? ORDER BY line LIMIT 1');
    return files.map((f) => {
      const s = first.get(f.path) as { line: number; level: number; heading: string; crumb: string; body: string } | null;
      return {
        file: f.path,
        line: s?.line ?? 1,
        level: s?.level ?? 0,
        heading: s?.heading ?? f.title,
        crumb: s?.crumb ?? f.title,
        docTitle: f.title,
        snippet: (s?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      };
    });
  }

  /** Every indexed diagram under these roots (all when none), by path and line. */
  diagrams(roots: string[] = []): Diagram[] {
    const abs = roots.map((r) => resolve(r));
    const rows = this.db.query('SELECT * FROM diagrams ORDER BY path, line').all() as {
      path: string;
      line: number;
      id: string;
      explicit: number;
      title: string;
      type: string | null;
      source: string;
    }[];
    return rows
      .filter((r) => !abs.length || abs.some((root) => within(r.path, root)))
      .map((r) => ({ file: r.path, line: r.line, id: r.id, explicitId: !!r.explicit, title: r.title, type: r.type, source: r.source }));
  }

  /** Indexed documents under these roots, with their titles. */
  docs(roots: string[] = []): { file: string; title: string; frontmatter: Record<string, string> }[] {
    const abs = roots.map((r) => resolve(r));
    return (this.db.query('SELECT path, title, frontmatter FROM files ORDER BY path').all() as { path: string; title: string; frontmatter: string }[])
      .filter((r) => !abs.length || abs.some((root) => within(r.path, root)))
      .map((r) => ({ file: r.path, title: r.title, frontmatter: JSON.parse(r.frontmatter) }));
  }
}
