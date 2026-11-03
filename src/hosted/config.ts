// `trawl serve` configuration, all from the environment (12-factor; secrets come from AWS Secrets Manager through the
// ECS task definition). Validated up front: a misconfigured server refuses to start rather than run half-open.

export interface ServeConfig {
  /** Where people reach the server, e.g. https://trawl.internal.example.com (OAuth redirects and links use it). */
  publicUrl: URL;
  port: number;
  google: { clientId: string; clientSecret: string };
  /** Google Workspace domains allowed in (the ID token's `hd` claim). */
  domains: string[];
  /** Who may file change requests / open PRs: emails, `@domain` for a whole domain, or `*` for everyone allowed in. */
  requesters: string[];
  proposers: string[];
  /** Signs sessions and MCP tokens (HMAC-SHA256, separate derived keys). At least 32 characters. */
  secret: string;
  sessionHours: number;
  tokenDays: number;
  /** Tokens issued before this instant are rejected (revoke everything by moving it forward). */
  tokensNotBefore: number;
  /** Revoked token ids (jti). */
  revokedTokens: Set<string>;
  /** Docs: a prebuilt `trawl site` folder, or a GitHub repo synced through the GitHub App. */
  siteDir?: string;
  repo?: { name: string; branch: string; paths: string[]; syncMinutes: number };
  githubApp?: { appId: string; privateKey: string; installationId?: string };
  /** Plain http on localhost for development: cookies lose `Secure`. Never set in a deployment. */
  insecureDev: boolean;
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Reads and validates the configuration; throws one error listing every problem. */
export function loadServeConfig(env: Record<string, string | undefined> = process.env): ServeConfig {
  const problems: string[] = [];
  const need = (key: string) => {
    const v = env[key]?.trim();
    if (!v) problems.push(`${key} is required`);
    return v ?? '';
  };

  let publicUrl: URL | undefined;
  try {
    publicUrl = new URL(need('TRAWL_PUBLIC_URL'));
  } catch {
    problems.push('TRAWL_PUBLIC_URL must be a URL like https://trawl.internal.example.com');
  }
  const insecureDev = env.TRAWL_INSECURE_DEV === '1';
  if (publicUrl && publicUrl.protocol !== 'https:' && !(insecureDev && ['localhost', '127.0.0.1'].includes(publicUrl.hostname))) {
    problems.push('TRAWL_PUBLIC_URL must be https (TRAWL_INSECURE_DEV=1 allows http://localhost for development only)');
  }

  const domains = list(env.TRAWL_ALLOWED_DOMAINS).map((d) => d.toLowerCase());
  if (!domains.length) problems.push('TRAWL_ALLOWED_DOMAINS is required (your Google Workspace domain, e.g. example.com)');
  const secret = need('TRAWL_SECRET');
  if (secret && secret.length < 32) problems.push('TRAWL_SECRET must be at least 32 characters (openssl rand -hex 32)');

  const repoName = env.TRAWL_GITHUB_REPO?.trim();
  const siteDir = env.TRAWL_SITE_DIR?.trim();
  if (!repoName && !siteDir) problems.push('set TRAWL_GITHUB_REPO (docs synced from GitHub) or TRAWL_SITE_DIR (a prebuilt trawl site)');
  if (repoName && !/^[\w.-]+\/[\w.-]+$/.test(repoName)) problems.push('TRAWL_GITHUB_REPO must be owner/name');

  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  if (repoName && (!appId || !privateKey)) problems.push('TRAWL_GITHUB_REPO needs GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (a GitHub App installed on that repo)');
  if (privateKey && !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey)) problems.push('GITHUB_APP_PRIVATE_KEY must be the App\'s PEM private key');

  const num = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) problems.push(`${key} must be a number from ${min} to ${max}`);
    return n;
  };
  const port = num('TRAWL_PORT', 8080, 1, 65535);
  const sessionHours = num('TRAWL_SESSION_HOURS', 8, 1, 72);
  const tokenDays = num('TRAWL_TOKEN_DAYS', 30, 1, 365);
  const syncMinutes = num('TRAWL_SYNC_MINUTES', 10, 1, 1440);
  const notBefore = env.TRAWL_TOKENS_NOT_BEFORE ? Date.parse(env.TRAWL_TOKENS_NOT_BEFORE) : 0;
  if (Number.isNaN(notBefore)) problems.push('TRAWL_TOKENS_NOT_BEFORE must be an ISO date');

  const google = { clientId: need('GOOGLE_CLIENT_ID'), clientSecret: need('GOOGLE_CLIENT_SECRET') };
  if (problems.length) throw new Error(`trawl serve: configuration problems:\n- ${problems.join('\n- ')}`);

  return {
    publicUrl: publicUrl!,
    port,
    google,
    domains,
    requesters: list(env.TRAWL_REQUESTERS).map((s) => s.toLowerCase()),
    proposers: list(env.TRAWL_PROPOSERS).map((s) => s.toLowerCase()),
    secret,
    sessionHours,
    tokenDays,
    tokensNotBefore: notBefore,
    revokedTokens: new Set(list(env.TRAWL_REVOKED_TOKENS)),
    siteDir,
    repo: repoName
      ? { name: repoName, branch: env.TRAWL_GITHUB_BRANCH?.trim() || 'main', paths: list(env.TRAWL_DOCS_PATHS), syncMinutes }
      : undefined,
    githubApp: appId && privateKey ? { appId, privateKey, installationId: env.GITHUB_APP_INSTALLATION_ID?.trim() || undefined } : undefined,
    insecureDev,
  };
}

/** Whether `email` matches a role list entry: the exact email, `@domain`, or `*`. */
export function inList(email: string, entries: string[]): boolean {
  const e = email.toLowerCase();
  return entries.some((x) => x === '*' || x === e || (x.startsWith('@') && e.endsWith(x)));
}
