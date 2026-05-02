import { Request } from 'express';

export interface AuthResult {
  key: string | null;
  mode: 'passthrough' | 'stored' | 'missing';
  provider: 'openai' | 'anthropic' | 'gemini' | 'unknown';
}

export function resolveAuth(req: Request, provider: 'openai' | 'anthropic' | 'gemini' | 'unknown'): AuthResult {
  // Mode 1: Passthrough — key in Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const key = authHeader.slice(7);
    if (key && key !== 'undefined' && key !== 'null') {
      return { key, mode: 'passthrough', provider };
    }
  }

  // Mode 2: Stored key — environment variables
  const envKey = getStoredKey(provider);
  if (envKey) {
    return { key: envKey, mode: 'stored', provider };
  }

  return { key: null, mode: 'missing', provider };
}

function getStoredKey(provider: 'openai' | 'anthropic' | 'gemini' | 'unknown'): string | null {
  switch (provider) {
    case 'openai': return process.env.OPENAI_API_KEY ?? null;
    case 'anthropic': return process.env.ANTHROPIC_API_KEY ?? null;
    case 'gemini': return process.env.GEMINI_API_KEY ?? null;
    default: return process.env.OPENAI_API_KEY ?? null;
  }
}

export function detectProvider(model: string): 'openai' | 'anthropic' | 'gemini' | 'unknown' {
  if (!model) return 'unknown';
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'gemini';
  return 'unknown';
}
