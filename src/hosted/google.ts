// Google sign-in (OpenID Connect authorization code flow with PKCE), restricted to Google Workspace domains.
import { type Jwk, randomToken, sha256b64url, verifyRs256 } from './crypto.ts';

export interface OidcEndpoints {
  authorize: string;
  token: string;
  jwks: string;
  issuers: string[];
}

export const GOOGLE: OidcEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};

/** What the login round trip keeps in a short-lived signed cookie between /auth/login and /auth/callback. */
export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

export async function startLogin(
  clientId: string,
  redirectUri: string,
  domains: string[],
  returnTo: string,
  endpoints = GOOGLE,
): Promise<{ url: string; login: LoginState }> {
  const login: LoginState = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), returnTo, exp: Date.now() + 10 * 60_000 };
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: login.state,
    nonce: login.nonce,
    code_challenge: await sha256b64url(login.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  // A hint for Google's account picker only; the domain is enforced on the ID token below.
  if (domains.length === 1) params.set('hd', domains[0]);
  return { url: `${endpoints.authorize}?${params}`, login };
}

let jwksCache: { at: number; url: string; keys: Jwk[] } | undefined;

async function jwks(url: string, fetchImpl: typeof fetch, refresh = false): Promise<Jwk[]> {
  if (!refresh && jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), url, keys };
  return keys;
}

export interface Identity {
  email: string;
  name?: string;
  domain: string;
}

/**
 * Exchanges the code and verifies the ID token: signature (Google's keys), issuer, audience, expiry, nonce, a
 * verified email, and a Workspace domain (`hd`) on the allow list. `hd` is only present for Workspace accounts, so
 * a personal Gmail address can't get in even with a matching-looking email.
 */
export async function finishLogin(
  opts: { clientId: string; clientSecret: string; redirectUri: string; domains: string[] },
  login: LoginState,
  code: string,
  endpoints = GOOGLE,
  fetchImpl: typeof fetch = fetch,
): Promise<Identity> {
  const res = await fetchImpl(endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      code_verifier: login.verifier,
    }),
  });
  const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !tokens.id_token) throw new Error(`token exchange failed: ${tokens.error ?? res.status}`);

  let claims: Record<string, unknown>;
  try {
    claims = await verifyRs256(tokens.id_token, await jwks(endpoints.jwks, fetchImpl));
  } catch (e) {
    // Google rotates keys: retry once with fresh ones on an unknown key.
    if (!(e instanceof Error && e.message === 'unknown signing key')) throw e;
    claims = await verifyRs256(tokens.id_token, await jwks(endpoints.jwks, fetchImpl, true));
  }
  const now = Date.now() / 1000;
  if (!endpoints.issuers.includes(String(claims.iss))) throw new Error('wrong issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) throw new Error('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('expired ID token');
  if (claims.nonce !== login.nonce) throw new Error('nonce mismatch');
  if (claims.email_verified !== true || typeof claims.email !== 'string') throw new Error('email not verified');
  const domain = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '';
  if (!domain || !opts.domains.includes(domain)) throw new Error(`account not in an allowed domain (${domain || 'personal account'})`);
  return { email: claims.email.toLowerCase(), name: typeof claims.name === 'string' ? claims.name : undefined, domain };
}
