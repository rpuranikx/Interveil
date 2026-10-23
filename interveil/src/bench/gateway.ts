/**
 * Measures the latency the Interveil gateway adds on top of the provider.
 *
 *   pnpm bench                     # after pnpm build
 *   node dist/bench/gateway.js --requests 1000 --streams 100 --json results.json
 *
 * A local fake OpenAI-compatible provider answers instantly, so the numbers are
 * the gateway's own overhead (parsing, tracing, policy checks, proxying), not
 * network or model time. Each request is paired with a direct call to the same
 * fake provider and the difference is reported.
 */
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { startServer } from '../server.js';
import { setPolicy } from '../policy/engine.js';
import { setStore, MemoryStore } from '../store/memory.js';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const REQUESTS = arg('requests', 500);
const STREAMS = arg('streams', 50);
const CHUNKS = 20;
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function startProvider(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const wantsTool = body.messages?.[0]?.content === 'tool';
      if (!body.stream) {
        const message = wantsTool
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'refund', arguments: '{"amount":20}' } }] }
          : { role: 'assistant', content: 'ok' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < CHUNKS; i++) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `t${i} ` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

interface Timing { ms: number; ttfbMs: number; ok: boolean }

function post(port: number, urlPath: string, payload: object, headers: Record<string, string> = {}): Promise<Timing> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const t0 = process.hrtime.bigint();
    let ttfb = 0;
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: 'Bearer sk-bench', ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { if (!ttfb) ttfb = Number(process.hrtime.bigint() - t0) / 1e6; body += d; });
      res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, ttfbMs: ttfb, ok: res.statusCode === 200 && body.length > 0 }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const pct = (values: number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const summary = (values: number[]) => ({ p50: +pct(values, 50).toFixed(2), p95: +pct(values, 95).toFixed(2), p99: +pct(values, 99).toFixed(2) });

async function paired(providerPort: number, gatewayPort: number, content: string, n: number) {
  const body = { model: 'gpt-4o', messages: [{ role: 'user', content }] };
  const added: number[] = [];
  for (let i = 0; i < n; i++) {
    const direct = await post(providerPort, '/v1/chat/completions', body);
    const viaGateway = await post(gatewayPort, '/v1/proxy/chat/completions', body, { 'x-interveil-session-id': `bench-${content}-${i}`, 'x-interveil-agent-id': 'bench' });
    if (!viaGateway.ok) throw new Error('gateway request failed');
    added.push(viaGateway.ms - direct.ms);
  }
  return summary(added);
}

async function main() {
  process.env.INTERVEIL_RATE_LIMIT_GATEWAY = '0';
  process.env.INTERVEIL_RATE_LIMIT_API = '0';
  const provider = await startProvider();
  const providerPort = (provider.address() as AddressInfo).port;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  setPolicy({
    version: '1',
    agents: [{ id: 'bench', rules: [{ id: 'large-refunds', action: 'block', condition: { tool: 'refund', 'args.0.amount': { greaterThan: 100 } } }] }],
  });

  const results: Record<string, unknown> = {
    environment: { node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model.trim(), cores: os.cpus().length },
    requests: REQUESTS,
  };

  for (const storage of ['memory', 'sqlite'] as const) {
    setStore(new MemoryStore());
    const dbPath = storage === 'sqlite' ? path.join(mkdtempSync(path.join(os.tmpdir(), 'interveil-bench-')), 'bench.db') : undefined;
    const { port, server } = await startServer({ port: 0, dbPath });

    await paired(providerPort, port, 'warmup', 50);
    const text = await paired(providerPort, port, 'text', REQUESTS);
    const toolCall = await paired(providerPort, port, 'tool', REQUESTS);

    const streamBody = { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'stream' }] };
    const t0 = Date.now();
    const streams = await Promise.all(Array.from({ length: STREAMS }, (_, i) =>
      post(port, '/v1/proxy/chat/completions', streamBody, { 'x-interveil-session-id': `bench-stream-${i}` })));
    const streamWallMs = Date.now() - t0;

    results[storage] = {
      added_ms_text_response: text,
      added_ms_tool_call_with_policy_check: toolCall,
      concurrent_streams: {
        streams: STREAMS,
        completed: streams.filter(s => s.ok).length,
        wall_ms: streamWallMs,
        ttfb_ms: summary(streams.map(s => s.ttfbMs)),
      },
    };
    server.close();
  }

  provider.close();
  agent.destroy();

  const fmt = (s: { p50: number; p95: number; p99: number }) => `p50 ${s.p50} ms · p95 ${s.p95} ms · p99 ${s.p99} ms`;
  const env = results.environment as Record<string, unknown>;
  console.log(`\nInterveil gateway overhead — ${REQUESTS} paired requests, Node ${env.node}, ${env.cpu} (${env.cores} cores), ${env.platform}\n`);
  for (const storage of ['memory', 'sqlite'] as const) {
    const r = results[storage] as {
      added_ms_text_response: { p50: number; p95: number; p99: number };
      added_ms_tool_call_with_policy_check: { p50: number; p95: number; p99: number };
      concurrent_streams: { streams: number; completed: number; wall_ms: number; ttfb_ms: { p50: number; p95: number; p99: number } };
    };
    console.log(`[${storage} store]`);
    console.log(`  added latency, text response:          ${fmt(r.added_ms_text_response)}`);
    console.log(`  added latency, tool call + policy:     ${fmt(r.added_ms_tool_call_with_policy_check)}`);
    console.log(`  ${r.concurrent_streams.streams} concurrent streams (${CHUNKS} chunks): ${r.concurrent_streams.completed}/${r.concurrent_streams.streams} completed in ${r.concurrent_streams.wall_ms} ms, TTFB ${fmt(r.concurrent_streams.ttfb_ms)}\n`);
  }
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(results, null, 2) + '\n');
    console.log(`Wrote ${jsonOut}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
