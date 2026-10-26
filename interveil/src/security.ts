import { Request, Response, NextFunction, RequestHandler } from 'express';
import { IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';

export interface SecurityOptions {
  /** Shared secret required on /api, /v1 and /ws. Unset = no key required (local use). */
  apiKey?: string;
  /** Extra browser origins allowed to call the server. The dashboard's own origin is always allowed. */
  allowedOrigins: string[];
  /** Host names accepted without an API key, besides loopback names (INTERVEIL_ALLOWED_HOSTS). */
  allowedHosts: string[];
}

export function resolveSecurityOptions(options: { apiKey?: string; allowedOrigins?: string | string[]; allowedHosts?: string[] }): SecurityOptions {
  const fromEnv = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
  const origins = options.allowedOrigins ?? fromEnv;
  const hosts = options.allowedHosts ?? (process.env.INTERVEIL_ALLOWED_HOSTS ? process.env.INTERVEIL_ALLOWED_HOSTS.split(',') : []);
  return {
    apiKey: options.apiKey ?? (process.env.INTERVEIL_API_KEY || undefined),
    allowedOrigins: (Array.isArray(origins) ? origins : [origins]).map(o => o.trim()).filter(Boolean),
    allowedHosts: hosts.map(h => h.trim().toLowerCase()).filter(Boolean),
  };
}

export function keyMatches(provided: string | undefined | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Interveil key from `x-interveil-key`, `Authorization: Bearer`, or `?token=` (WebSocket only). */
export function presentedKeys(req: IncomingMessage, url?: URL): string[] {
  const keys: string[] = [];
  const header = req.headers['x-interveil-key'];
  if (typeof header === 'string') keys.push(header);
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) keys.push(auth.slice(7));
  const token = url?.searchParams.get('token');
  if (token) keys.push(token);
  return keys;
}

export function isAuthorized(req: IncomingMessage, sec: SecurityOptions, url?: URL): boolean {
  if (!sec.apiKey) return true;
  return presentedKeys(req, url).some(k => keyMatches(k, sec.apiKey!));
}

/**
 * Browsers always send Origin on cross-site requests, including "simple" POSTs
 * that skip CORS preflight and WebSocket upgrades that CORS never covers. Only
 * same-origin and explicitly allowed origins get through; non-browser clients
 * send no Origin and are unaffected.
 */
export function isOriginAllowed(req: IncomingMessage, sec: SecurityOptions): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (sec.allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * DNS rebinding: a page on attacker.example re-resolves its own name to
 * 127.0.0.1, so the browser treats calls to this server as same-origin and the
 * Origin check passes. The Host header still says attacker.example. Without an
 * API key, only loopback host names (and INTERVEIL_ALLOWED_HOSTS) are served.
 * With a key, the page cannot authenticate anyway.
 */
export function isHostAllowed(req: IncomingMessage, sec: SecurityOptions): boolean {
  if (sec.apiKey) return true;
  const header = req.headers.host;
  if (!header) return true; // browsers always send Host; this is a non-browser HTTP/1.0 client
  const host = header.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return isLoopback(host) || host.endsWith('.localhost') || sec.allowedHosts.includes(host);
}

export function hostGuard(sec: SecurityOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isHostAllowed(req, sec)) return next();
    res.status(403).json({ ok: false, error: `Host ${req.headers.host} is not allowed. Set INTERVEIL_API_KEY, or add it to INTERVEIL_ALLOWED_HOSTS.` });
  };
}

export function originGuard(sec: SecurityOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isOriginAllowed(req, sec)) return next();
    res.status(403).json({ ok: false, error: `Origin ${req.headers.origin} is not allowed. Add it with --allowed-origins.` });
  };
}

export function requireApiKey(sec: SecurityOptions, opts: { exempt?: (req: Request) => boolean } = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (opts.exempt?.(req) || isAuthorized(req, sec)) return next();
    res.status(401).json({
      ok: false,
      error: 'Interveil API key required: send it as the x-interveil-key header or Authorization: Bearer <key>.',
    });
  };
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}
