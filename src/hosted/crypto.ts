// Signing for sessions and MCP tokens (HMAC-SHA256) and RS256 JWT verification for Google ID tokens, on WebCrypto.

const enc = new TextEncoder();

export function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = Buffer.from(s, 'base64url');
  const out = new Uint8Array(new ArrayBuffer(b.length));
  out.set(b);
  return out;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const keys = new Map<string, Promise<CryptoKey>>();

/** A purpose-bound HMAC key derived from the server secret, so a session can never pass as a token or vice versa. */
function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  const id = `${purpose}\0${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = (async () => {
      const master = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const derived = new Uint8Array(await crypto.subtle.sign('HMAC', master, enc.encode(`trawl:${purpose}`)));
      return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    })();
    keys.set(id, key);
  }
  return key;
}

/** `prefix` + base64url(JSON) + `.` + base64url(HMAC). */
export async function sign(secret: string, purpose: string, payload: object, prefix = ''): Promise<string> {
  const body = b64url(JSON.stringify(payload));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, purpose), enc.encode(`${prefix}${body}`)));
  return `${prefix}${body}.${b64url(mac)}`;
}

/** The payload if the signature is valid for this purpose (expiry is the caller's check); null otherwise. */
export async function verify<T>(secret: string, purpose: string, value: string, prefix = ''): Promise<T | null> {
  if (!value.startsWith(prefix) || value.length > 4096) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= prefix.length) return null;
  const signed = value.slice(0, dot);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, purpose), enc.encode(signed)));
  if (!safeEqual(b64url(mac), value.slice(dot + 1))) return null;
  try {
    return JSON.parse(Buffer.from(signed.slice(prefix.length), 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256b64url(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

export interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

/**
 * Verifies an RS256 JWT against a JWKS and returns its claims, or throws with the reason. Checks the signature and
 * `alg` only; the caller checks iss/aud/exp/nonce.
 */
export async function verifyRs256(jwt: string, jwks: Jwk[]): Promise<Record<string, unknown>> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);
  const jwk = jwks.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('bad signature');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}
