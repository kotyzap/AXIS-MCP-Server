// Minimal VAPIX HTTP client with Digest authentication.
//
// CRITICAL (skill: web-ui-and-vapix.md): the Digest client MUST honour the
// `algorithm` directive. Modern AXIS OS challenges with MD5 *or* SHA-256 (and the
// `-sess` variants); an MD5-only response to a SHA-256 challenge returns a silent
// 401 that looks exactly like a wrong password.
//
// Performance: the parsed challenge is cached per (host, realm) and the Digest
// header is sent proactively on later requests (incrementing nc). We only
// re-challenge on a 401 (stale nonce).
import * as http from 'http';
import * as crypto from 'crypto';
import { loadSettings } from './settings';

export interface VapixResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text(): string;
}

interface Challenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: string; // e.g. MD5, SHA-256, MD5-sess, SHA-256-sess
}

export interface VapixRequestOptions {
  method?: string;
  path: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
  /** Query params appended to the path. */
  query?: Record<string, string | number | undefined>;
}

const challengeCache = new Map<string, { challenge: Challenge; nc: number }>();

function parseChallenge(header: string): Challenge | null {
  // Strip leading "Digest "
  const idx = header.toLowerCase().indexOf('digest ');
  if (idx === -1) return null;
  const body = header.slice(idx + 7);
  const out: Record<string, string> = {};
  // Match key=value where value is quoted or a token.
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1].toLowerCase()] = (m[2] !== undefined ? m[2] : m[3]).trim();
  }
  if (!out.realm || !out.nonce) return null;
  return {
    realm: out.realm,
    nonce: out.nonce,
    qop: out.qop,
    opaque: out.opaque,
    algorithm: out.algorithm || 'MD5',
  };
}

function buildAuthHeader(
  ch: Challenge,
  user: string,
  pass: string,
  method: string,
  uri: string,
  nc: number,
): string {
  const algoUpper = ch.algorithm.toUpperCase();
  const sha = algoUpper.startsWith('SHA-256') || algoUpper.startsWith('SHA256');
  const sess = algoUpper.endsWith('-SESS');
  const H = (s: string) => crypto.createHash(sha ? 'sha256' : 'md5').update(s).digest('hex');

  const cnonce = crypto.randomBytes(8).toString('hex');
  const ncHex = nc.toString(16).padStart(8, '0');

  let ha1 = H(`${user}:${ch.realm}:${pass}`);
  if (sess) ha1 = H(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);

  const response = ch.qop
    ? H(`${ha1}:${ch.nonce}:${ncHex}:${cnonce}:${ch.qop}:${ha2}`)
    : H(`${ha1}:${ch.nonce}:${ha2}`);

  const parts = [
    `username="${user}"`,
    `realm="${ch.realm}"`,
    `nonce="${ch.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${ch.algorithm}`,
    `response="${response}"`,
  ];
  if (ch.qop) {
    parts.push(`qop=${ch.qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  }
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`);
  return 'Digest ' + parts.join(', ');
}

function rawRequest(
  host: string,
  method: string,
  uri: string,
  headers: Record<string, string>,
  body?: string | Buffer,
): Promise<VapixResponse> {
  const port = parseInt(process.env.VAPIX_PORT ?? '80', 10);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, method, path: uri, headers, timeout: 15000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: buf,
            text: () => buf.toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('VAPIX request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

function buildUri(opts: VapixRequestOptions): string {
  let uri = opts.path;
  if (opts.query) {
    const qs = Object.entries(opts.query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (qs) uri += (uri.includes('?') ? '&' : '?') + qs;
  }
  return uri;
}

/**
 * Perform an authenticated VAPIX request. Sends the Digest header proactively
 * when a challenge is cached; falls back to the 401 -> retry handshake otherwise.
 */
export async function vapix(opts: VapixRequestOptions): Promise<VapixResponse> {
  const s = loadSettings();
  const host = s.vapixHost || '127.0.0.1';
  const user = s.vapixUser;
  const pass = s.vapixPass;
  const method = (opts.method || 'GET').toUpperCase();
  const uri = buildUri(opts);
  const baseHeaders: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.body) baseHeaders['Content-Length'] = String(Buffer.byteLength(opts.body));

  const cacheKey = host;
  const cached = challengeCache.get(cacheKey);

  // 1) Proactive Digest header from cached challenge.
  if (cached && user) {
    cached.nc += 1;
    const auth = buildAuthHeader(cached.challenge, user, pass, method, uri, cached.nc);
    const res = await rawRequest(host, method, uri, { ...baseHeaders, Authorization: auth }, opts.body);
    if (res.status !== 401) return res;
    challengeCache.delete(cacheKey); // stale nonce — fall through to re-challenge
  }

  // 2) Unauthenticated probe to obtain the challenge.
  const probe = await rawRequest(host, method, uri, baseHeaders, opts.body);
  if (probe.status !== 401) return probe; // endpoint may be anonymous
  if (!user) return probe; // no credentials configured

  const wwwAuth = probe.headers['www-authenticate'];
  const challengeStr = Array.isArray(wwwAuth) ? wwwAuth.join(', ') : wwwAuth;
  if (!challengeStr) return probe;
  const challenge = parseChallenge(challengeStr);
  if (!challenge) return probe;

  // 3) Retry with a proper Digest response.
  const nc = 1;
  challengeCache.set(cacheKey, { challenge, nc });
  const auth = buildAuthHeader(challenge, user, pass, method, uri, nc);
  return rawRequest(host, method, uri, { ...baseHeaders, Authorization: auth }, opts.body);
}

/** Convenience: GET returning text, throws VapixError on non-2xx. */
export async function vapixGetText(path: string, query?: VapixRequestOptions['query']): Promise<string> {
  const res = await vapix({ method: 'GET', path, query });
  if (res.status < 200 || res.status >= 300) {
    throw new VapixError(res.status, res.text(), path);
  }
  return res.text();
}

export class VapixError extends Error {
  constructor(public status: number, public bodyExcerpt: string, public path: string) {
    super(`VAPIX ${path} -> HTTP ${status}: ${bodyExcerpt.slice(0, 300)}`);
    this.name = 'VapixError';
  }
}
