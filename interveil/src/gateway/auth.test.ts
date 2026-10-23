import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Request } from 'express';
import { resolveAuth } from './auth.js';

const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} }) as unknown as Request;
const security = { apiKey: 'interveil-key', allowedOrigins: [] };

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
