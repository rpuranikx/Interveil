import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Request } from 'express';
import { resolveAuth, detectProvider } from './auth.js';

const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} }) as unknown as Request;
const security = { apiKey: 'interveil-key', allowedOrigins: [], allowedHosts: [] };

describe('resolveAuth', () => {
  const saved = process.env.OPENAI_API_KEY;
  beforeEach(() => { process.env.OPENAI_API_KEY = 'sk-stored'; });
  afterEach(() => { process.env.OPENAI_API_KEY = saved; });

  it('forwards a client-supplied provider key', () => {
    expect(resolveAuth(req('Bearer sk-client'), 'openai', security)).toMatchObject({ key: 'sk-client', mode: 'passthrough' });
  });

  it('uses the stored provider key when the bearer is the Interveil key', () => {
    expect(resolveAuth(req('Bearer interveil-key'), 'openai', security)).toMatchObject({ key: 'sk-stored', mode: 'stored' });
  });

  it('never forwards the Interveil key to a provider', () => {
    delete process.env.OPENAI_API_KEY;
    expect(resolveAuth(req('Bearer interveil-key'), 'openai', security)).toMatchObject({ key: null, mode: 'missing' });
  });
});

describe('detectProvider', () => {
  it.each([
    ['gpt-4o', 'openai'], ['o1', 'openai'], ['o3-mini', 'openai'], ['o4-mini', 'openai'], ['codex-mini-latest', 'openai'], ['chatgpt-4o-latest', 'openai'],
    ['claude-sonnet-4-5', 'anthropic'], ['gemini-2.5-pro', 'gemini'],
    ['openrouter/auto', 'unknown'], ['anthropic/claude-sonnet-4', 'unknown'], ['hermes-3-llama-3.1-70b', 'unknown'], ['omega-7b', 'unknown'],
  ])('%s → %s', (model, provider) => {
    expect(detectProvider(model)).toBe(provider);
  });
});
