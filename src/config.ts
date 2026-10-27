import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  /** Folders scanned by `--all` and offered by `--choose`. */
  roots: string[];
}

export const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'trawl', 'config.json');

export function expandHome(path: string): string {
  return resolve(path.replace(/^~(?=$|\/)/, homedir()));
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
