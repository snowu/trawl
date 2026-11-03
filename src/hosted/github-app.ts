// GitHub App access to the docs repo: an App JWT (RS256, 9 minutes) is exchanged for an installation token (1 hour,
// scoped to the installation's repos and permissions), refreshed before it expires. No personal tokens anywhere.
import { createPrivateKey, sign as rsaSign } from 'node:crypto';
import type { Json } from '../mcp-protocol.ts';
import type { GitHubApi } from './docs.ts';
import { b64url } from './crypto.ts';

const API = 'https://api.github.com';

export class GitHubApp {
  private token: { value: string; exp: number } | undefined;
  private installationId: string | undefined;

  constructor(
    private appId: string,
    private privateKeyPem: string,
    readonly repo: string,
    installationId?: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.installationId = installationId;
    createPrivateKey(privateKeyPem); // fail at startup on a bad key, not on the first request
  }

  /** The App's own JWT (iat backdated 60s for clock skew, as GitHub recommends). */
  appJwt(now = Math.floor(Date.now() / 1000)): string {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.appId }));
    const sig = rsaSign('RSA-SHA256', Buffer.from(`${head}.${body}`), createPrivateKey(this.privateKeyPem));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  }

  private async raw(url: string, init: RequestInit, auth: string): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      headers: {
        authorization: auth,
        accept: 'application/vnd.github+json',
        'user-agent': 'trawl-serve',
        'x-github-api-version': '2022-11-28',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  }

  private async installationToken(): Promise<string> {
    if (this.token && this.token.exp - Date.now() > 5 * 60_000) return this.token.value;
    const auth = `Bearer ${this.appJwt()}`;
    if (!this.installationId) {
      const res = await this.raw(`${API}/repos/${this.repo}/installation`, {}, auth);
      if (!res.ok) throw new Error(`GitHub App is not installed on ${this.repo} (${res.status})`);
      this.installationId = String(((await res.json()) as { id: number }).id);
    }
    const res = await this.raw(`${API}/app/installations/${this.installationId}/access_tokens`, { method: 'POST', body: JSON.stringify({ repositories: [this.repo.split('/')[1]] }) }, auth);
    if (!res.ok) throw new Error(`GitHub installation token: ${res.status}`);
    const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };
    this.token = { value: token, exp: Date.parse(expires_at) };
    return token;
  }

  /** A REST call relative to /repos/OWNER/NAME, as the App. */
  api: GitHubApi = async (path, init = {}) => {
    const res = await this.raw(`${API}/repos/${this.repo}${path}`, { method: init.method ?? 'GET', body: init.body ? JSON.stringify(init.body) : undefined }, `Bearer ${await this.installationToken()}`);
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${json.message ?? ''}`.trim());
    return json;
  };
}
