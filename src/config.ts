import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface Config {
  /** Folders bare `trawl` scans; manage them with `trawl roots`. */
  roots: string[];
}

export const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'trawl', 'config.json');

export function expandHome(path: string): string {
  return resolve(path.replace(/^~(?=$|\/)/, homedir()));
}

/** Writes the roots, ~-relative so the file reads well and works for any user. */
export async function saveConfig(config: Config, path = CONFIG_PATH): Promise<void> {
  const home = homedir();
  const roots = [...new Set(config.roots)].map((r) => (r === home || r.startsWith(`${home}/`) ? `~${r.slice(home.length)}` : r));
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify({ roots }, null, 2)}\n`);
}

/** Reads the config file; a missing file means no roots. */
export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { roots: [] };

  const raw: unknown = await file.json();
  const roots = (raw as { roots?: unknown }).roots;
  if (!Array.isArray(roots) || !roots.every((r) => typeof r === 'string')) {
    throw new Error(`${path}: "roots" must be a list of folder paths`);
  }
  return { roots: roots.map(expandHome) };
}
