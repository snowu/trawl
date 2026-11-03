/**
 * Runs git and returns its stdout, or null when it fails or git isn't installed at all (e.g. the distroless
 * container): Bun throws for a missing executable instead of returning a failed result.
 */
export function runGit(args: string[], cwd?: string, opts: { stderr?: boolean } = {}): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = Bun.spawnSync(['git', ...args], { cwd, stderr: opts.stderr ? 'pipe' : 'ignore' });
    return { ok: r.success, stdout: r.stdout.toString(), stderr: r.stderr?.toString() ?? '' };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}
