import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { proxyStream, StreamResult } from './streaming.js';

// A fake provider whose behavior is chosen by the request path.
const upstream = http.createServer((req, res) => {
  if (req.url === '/unauthorized') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = (s: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;
  if (req.url === '/slow') {
    // Keeps streaming until the client goes away.
    const t = setInterval(() => res.write(delta('tick ')), 10);
    res.on('close', () => clearInterval(t));
    return;
  }
  const first = delta('Hello, ');
  // Split one SSE line across two writes to exercise line buffering.
  res.write(first.slice(0, 20));
  setTimeout(() => {
    res.write(first.slice(20) + delta('world'));
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  }, 10);
});

let upstreamUrl = '';
let gatewayUrl = '';
let gateway: http.Server;
const results: Record<string, StreamResult[]> = {};

beforeAll(async () => {
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const app = express();
  app.get('/proxy/:target', (req, res) => {
    const key = req.params.target;
    const target = key === 'unreachable' ? 'http://127.0.0.1:1/' : `${upstreamUrl}/${key}`;
    proxyStream(target, 'POST', {}, '{}', res, (result) => {
      (results[key] ??= []).push(result);
    });
  });
  gateway = app.listen(0, '127.0.0.1');
  await new Promise(r => gateway.once('listening', r));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

afterAll(() => {
  upstream.close();
  gateway.close();
});

function get(path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`${gatewayUrl}${path}`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
    }).on('error', reject);
  });
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 10));
};

describe('proxyStream', () => {
  it('forwards every chunk and closes the client response when upstream ends', async () => {
    const res = await get('/proxy/ok');
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/event-stream');
    expect(res.body).toContain('data: [DONE]');
  });

  it('assembles split SSE lines and reports completion exactly once', async () => {
    await waitFor(() => (results.ok?.length ?? 0) > 0);
    await new Promise(r => setTimeout(r, 50));
    expect(results.ok).toHaveLength(1);
    expect(results.ok[0]).toEqual({
      assembled: 'Hello, world',
      finish_reason: 'stop',
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  });

  it('passes upstream errors through with their status and content type', async () => {
    const res = await get('/proxy/unauthorized');
    expect(res.status).toBe(401);
    expect(res.type).toContain('application/json');
    expect(JSON.parse(res.body).error.message).toBe('bad key');
  });

  it('returns 502 and reports a partial result when upstream is unreachable', async () => {
    const res = await get('/proxy/unreachable');
    expect(res.status).toBe(502);
    await waitFor(() => (results.unreachable?.length ?? 0) > 0);
    expect(results.unreachable).toHaveLength(1);
    expect(results.unreachable[0].partial).toBe(true);
  });

  it('reports a partial result once when the client disconnects mid-stream', async () => {
    await new Promise<void>((resolve) => {
      const req = http.get(`${gatewayUrl}/proxy/slow`, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
    });
    await waitFor(() => (results.slow?.length ?? 0) > 0);
    await new Promise(r => setTimeout(r, 50));
    expect(results.slow).toHaveLength(1);
    expect(results.slow[0].partial).toBe(true);
    expect(results.slow[0].assembled).toContain('tick');
  });
});
