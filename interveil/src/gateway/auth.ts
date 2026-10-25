import { Request } from 'express';
import { SecurityOptions, keyMatches } from '../security.js';

export interface AuthResult {
  key: string | null;
  mode: 'passthrough' | 'stored' | 'missing';
  provider: 'openai' | 'anthropic' | 'gemini' | 'unknown';
}

/**
 * Picks the provider key for a gateway request:
 * - Passthrough: the client's own `Authorization: Bearer <provider key>` is forwarded.
 * - Stored: the server's OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY is used
 *   when the client sends no bearer, or sends the Interveil API key as its bearer
 *   (so an OpenAI SDK can use `api_key=<INTERVEIL_API_KEY>`).
 * Requests reach this point only after the /v1 API-key and origin checks.
 */
export function resolveAuth(
  req: Request,
  provider: AuthResult['provider'],
  security?: SecurityOptions,
): AuthResult {
  const authHeader = req.headers['authorization'];
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const isInterveilKey = !!security?.apiKey && keyMatches(bearer, security.apiKey);

  if (bearer && bearer !== 'undefined' && bearer !== 'null' && !isInterveilKey) {
    return { key: bearer, mode: 'passthrough', provider };
  }

  const envKey = getStoredKey(provider);
  if (envKey) {
    return { key: envKey, mode: 'stored', provider };
  }

  return { key: null, mode: 'missing', provider };
}

function getStoredKey(provider: AuthResult['provider']): string | null {
  switch (provider) {
    case 'openai': return process.env.OPENAI_API_KEY || null;
    case 'anthropic': return process.env.ANTHROPIC_API_KEY || null;
    case 'gemini': return process.env.GEMINI_API_KEY || null;
    default: return process.env.OPENAI_API_KEY || null;
  }
}

/** OpenAI's own model families. Anything unrecognized also goes to OPENAI_BASE_URL, as `unknown`. */
const OPENAI_MODEL = /^(?:gpt-|chatgpt-|o\d(?:$|-)|codex-|computer-use-|text-embedding-|omni-moderation)/;

export function detectProvider(model: string): AuthResult['provider'] {
  if (!model) return 'unknown';
  if (OPENAI_MODEL.test(model)) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'gemini';
  return 'unknown';
}
