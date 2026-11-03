// Keeps a `trawl site` build of the docs repo current: reads the branch through the GitHub App (git trees + blobs,
// only changed blobs are downloaded), writes the markdown into a scratch folder, builds the site, and swaps it in.
// A failed sync keeps serving the last good build.
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSite, type SiteData } from '../site.ts';
import { skipDir } from '../scan.ts';
import type { GitHubApi } from './docs.ts';

const DOC = /\.(md|mmd)$/i;
const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FILES = 5000;

export interface SiteBuild {
  dir: string;
  data: SiteData;
  commit: string;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

/** Which repo files the site needs: docs, images next to them, and .trawl/links.json; nothing in skipped folders. */
export function wanted(path: string, prefixes: string[]): boolean {
  if (path === '.trawl/links.json') return true;
  if (!DOC.test(path) && !IMAGE.test(path)) return false;
  if (prefixes.length && !prefixes.some((p) => path === p || path.startsWith(`${p.replace(/\/+$/, '')}/`))) return false;
  const parts = path.split('/');
  return !parts.slice(0, -1).some((name, i) => skipDir(`/${parts.slice(0, i + 1).join('/')}`, name));
}

export class RepoSync {
  private blobs = new Map<string, Uint8Array>();
  current: SiteBuild | undefined;
  lastError: string | undefined;

  constructor(
    private github: GitHubApi,
    private repo: { name: string; branch: string; paths: string[] },
    private workDir: string,
    private log: (event: Record<string, unknown>) => void = () => {},
  ) {}

  /** Syncs if the branch moved; returns whether a new build is live. */
  async sync(): Promise<boolean> {
    try {
      const ref = (await this.github(`/git/ref/heads/${encodeURIComponent(this.repo.branch)}`)) as { object: { sha: string } };
      const commit = ref.object.sha;
      if (this.current?.commit === commit) return false;
      const tree = (await this.github(`/git/trees/${commit}?recursive=1`)) as { tree: TreeEntry[]; truncated?: boolean };
      if (tree.truncated) this.log({ kind: 'sync', warning: 'repo tree truncated by GitHub; some files may be missing' });
      const files = tree.tree.filter((e) => e.type === 'blob' && wanted(e.path, this.repo.paths) && (e.size ?? 0) <= MAX_FILE).slice(0, MAX_FILES);

      const missing = files.filter((f) => !this.blobs.has(f.sha));
      for (let i = 0; i < missing.length; i += 8) {
        await Promise.all(
          missing.slice(i, i + 8).map(async (f) => {
            const blob = (await this.github(`/git/blobs/${f.sha}`)) as { content: string; encoding: string };
            this.blobs.set(f.sha, new Uint8Array(Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8')));
          }),
        );
      }
      // Forget blobs no longer in the tree, so memory tracks the repo, not its history.
      const live = new Set(files.map((f) => f.sha));
      for (const sha of this.blobs.keys()) if (!live.has(sha)) this.blobs.delete(sha);

      const src = join(this.workDir, `src-${commit}`);
      const out = join(this.workDir, `site-${commit}`);
      await rm(src, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
      await mkdir(src, { recursive: true });
      for (const f of files) {
        // Paths come from git, but never let one escape the scratch folder.
        if (f.path.split('/').some((p) => p === '..' || p === '')) continue;
        await Bun.write(join(src, f.path), this.blobs.get(f.sha)!);
      }
      const { data } = await buildSite({
        paths: [src],
        root: src,
        out,
        name: this.repo.name.split('/')[1],
        repo: { url: `https://github.com/${this.repo.name}`, branch: this.repo.branch },
      });
      const previous = this.current;
      this.current = { dir: out, data, commit };
      this.lastError = undefined;
      await rm(src, { recursive: true, force: true });
      if (previous) await rm(previous.dir, { recursive: true, force: true });
      this.log({ kind: 'sync', commit, docs: data.docs.length, diagrams: data.diagrams.length, downloaded: missing.length });
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log({ kind: 'sync', error: this.lastError });
      return false;
    }
  }
}
