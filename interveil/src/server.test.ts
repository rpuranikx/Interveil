import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { startServer } from './server.js';

const servers: Server[] = [];
afterAll(() => servers.forEach(s => s.close()));

async function boot(options: Parameters<typeof startServer>[0] = {}) {
  const started = await startServer({ port: 0, ...options });
  servers.push(started.server);
  return { ...started, address: (started.server.address() as AddressInfo).address };
}

function wsOutcome(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => setTimeout(() => { resolve('open'); ws.close(); }, 100));
    ws.on('close', (code) => resolve(`closed:${code}`));
    ws.on('unexpected-response', (_req, res) => resolve(`rejected:${res.statusCode}`));
    ws.on('error', () => {});
  });
}

describe('default (no API key)', () => {
  let base = '';
  let wsUrl = '';
  let address = '';
  beforeAll(async () => {
    const started = await boot();
    address = started.address;
    base = `http://127.0.0.1:${started.port}`;
    wsUrl = `ws://127.0.0.1:${started.port}/ws`;
  });

  it('binds to loopback only', () => {
    expect(address).toBe('127.0.0.1');
  });

  it('serves non-browser and same-origin requests', async () => {
    expect((await fetch(`${base}/api/v1/sessions`)).status).toBe(200);
    expect((await fetch(`${base}/api/v1/sessions`, { headers: { Origin: base } })).status).toBe(200);
  });

  it('refuses cross-origin requests, including simple POSTs that skip preflight', async () => {
    const evil = { Origin: 'https://evil.example' };
    expect((await fetch(`${base}/api/v1/sessions`, { headers: evil })).status).toBe(403);
    const post = await fetch(`${base}/v1/proxy/chat/completions`, {
      method: 'POST', headers: { ...evil, 'content-type': 'text/plain' }, body: '{}',
    });
    expect(post.status).toBe(403);
  });

  it('sends no CORS allow header by default', async () => {
    const res = await fetch(`${base}/api/v1/sessions`, { headers: { Origin: base } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses cross-origin WebSocket connections at the handshake', async () => {
    expect(await wsOutcome(wsUrl, { Origin: 'https://evil.example' })).toBe('rejected:401');
    expect(await wsOutcome(wsUrl)).toBe('open');
  });

  it('streams session creation and status changes to WebSocket clients', async () => {
    const ws = new WebSocket(wsUrl);
    const messages: any[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(String(m))));
    await new Promise(r => ws.once('open', r));

    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const json = { 'content-type': 'application/json' };
    await fetch(`${base}/api/v1/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ session_id: id, name: 'live' }) });
    await fetch(`${base}/api/v1/sessions/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'completed', ended_at: new Date().toISOString() }) });
    await new Promise(r => setTimeout(r, 100));
    ws.close();

    const updates = messages.filter(m => m.type === 'session' && m.session.session_id === id).map(m => m.session.status);
    expect(updates).toEqual(['running', 'completed']);
  });

  it('no longer exposes anonymous user registration', async () => {
    const res = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'mallory', password: 'password123', role: 'admin' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('rate limits', () => {
  const saved = { ...process.env };
  afterAll(() => { process.env = saved; });

  it('limits the gateway per client and does not count health checks', async () => {
    process.env.INTERVEIL_RATE_LIMIT_GATEWAY = '3';
    const { port } = await boot();
    const base = `http://127.0.0.1:${port}`;
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${base}/v1/proxy/models`)).status);
    expect(codes).toEqual([200, 200, 200, 429]);
    expect((await fetch(`${base}/api/v1/health`)).headers.get('ratelimit-remaining')).toBeNull();
  });

  it('keys clients by X-Forwarded-For only when INTERVEIL_TRUST_PROXY is set', async () => {
    process.env.INTERVEIL_RATE_LIMIT_GATEWAY = '1';
    const hit = (port: number, ip: string) => fetch(`http://127.0.0.1:${port}/v1/proxy/models`, { headers: { 'X-Forwarded-For': ip } }).then(r => r.status);

    const direct = await boot();
    expect([await hit(direct.port, '10.0.0.1'), await hit(direct.port, '10.0.0.2')]).toEqual([200, 429]);

    process.env.INTERVEIL_TRUST_PROXY = '1';
    const proxied = await boot();
    expect([await hit(proxied.port, '10.0.0.1'), await hit(proxied.port, '10.0.0.2')]).toEqual([200, 200]);
    delete process.env.INTERVEIL_TRUST_PROXY;
  });

  it('can be disabled with 0', async () => {
    process.env.INTERVEIL_RATE_LIMIT_GATEWAY = '0';
    const { port } = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/v1/proxy/models`);
    expect(res.headers.get('ratelimit-limit')).toBeNull();
  });
});

describe('with INTERVEIL_API_KEY', () => {
  const key = 'test-key-123';
  let base = '';
  let wsUrl = '';
  beforeAll(async () => {
    const { port } = await boot({ apiKey: key, allowedOrigins: ['https://dash.example'] });
    base = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
  });

  it('requires the key on the trace API', async () => {
    expect((await fetch(`${base}/api/v1/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/sessions`, { headers: { 'x-interveil-key': 'wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/api/v1/sessions`, { headers: { 'x-interveil-key': key } })).status).toBe(200);
    expect((await fetch(`${base}/api/v1/sessions`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(200);
  });

  it('requires the key on event ingestion and the gateway', async () => {
    const post = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    expect((await post('/api/v1/events')).status).toBe(401);
    expect((await post('/v1/proxy/chat/completions', { Authorization: 'Bearer sk-provider-key' })).status).toBe(401);
    expect((await post('/v1/mcp')).status).toBe(401);
  });

  it('leaves the health check open', async () => {
    expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
  });

  it('requires the key on the WebSocket', async () => {
    expect(await wsOutcome(wsUrl)).toBe('closed:4401');
    expect(await wsOutcome(`${wsUrl}?token=${key}`)).toBe('open');
  });

  it('allows configured origins and sets the CORS header for them', async () => {
    const res = await fetch(`${base}/api/v1/sessions`, { headers: { Origin: 'https://dash.example', 'x-interveil-key': key } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dash.example');
  });
});
