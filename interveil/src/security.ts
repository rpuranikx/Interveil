import { Request, Response, NextFunction, RequestHandler } from 'express';
import { IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';

export interface SecurityOptions {
  /** Shared secret required on /api, /v1 and /ws. Unset = no key required (local use). */
  apiKey?: string;
  /** Extra browser origins allowed to call the server. The dashboard's own origin is always allowed. */
  allowedOrigins: string[];
}

export function resolveSecurityOptions(options: { apiKey?: string; allowedOrigins?: string | string[] }): SecurityOptions {
  const fromEnv = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
  const origins = options.allowedOrigins ?? fromEnv;
  return {
    apiKey: options.apiKey ?? (process.env.INTERVEIL_API_KEY || undefined),
    allowedOrigins: (Array.isArray(origins) ? origins : [origins]).map(o => o.trim()).filter(Boolean),
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
