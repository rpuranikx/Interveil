import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { startServer } from '../server.js';
import { setPolicy } from '../policy/engine.js';
import { resetHalts } from './enforcement.js';

// Fake Anthropic and Gemini APIs speaking their native protocols. Each proposes a
// refund tool call whose amount comes from the user's message, so tests choose
// whether the policy should allow or block it.
const seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }> = [];
const amountOf = (text: string) => Number(/(\d+)/.exec(text)?.[1] ?? 0);

const anthropic = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw);
    seen.push({ path: req.url!, headers: req.headers, body });
    const amount = amountOf(JSON.stringify(body.messages));
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_1', model: body.model, stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'Refunding.' }, { type: 'tool_use', id: 'toolu_1', name: 'refund', input: { amount } }],
        usage: { input_tokens: 5, output_tokens: 5 },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: 'msg_1', model: body.model, usage: { input_tokens: 5 } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Refunding.' } });
    send('content_block_stop', { index: 0 });
    send('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'refund', input: {} } });
    send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"amount":' } });
    send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: `${amount}}` } });
    send('content_block_stop', { index: 1 });
    send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } });
    send('message_stop', {});
    res.end();
  });
});

const gemini = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw);
    seen.push({ path: req.url!, headers: req.headers, body });
    const amount = amountOf(JSON.stringify(body.contents));
    const candidate = { content: { role: 'model', parts: [{ text: 'Refunding.' }, { functionCall: { name: 'refund', args: { amount } } }] }, finishReason: 'STOP' };
    if (!req.url!.includes('streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [candidate], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Refunding.' }] } }] })}\r\n\r\n`);
    res.write(`data: ${JSON.stringify({ candidates: [{ ...candidate, content: { role: 'model', parts: [candidate.content.parts[1]] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 } })}\r\n\r\n`);
    res.end();
  });
});

let gateway = '';
let server: http.Server;
const saved = { ...process.env };

beforeAll(async () => {
  await new Promise<void>(r => anthropic.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => gemini.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}/v1`;
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(gemini.address() as AddressInfo).port}/v1beta`;
  const started = await startServer({ port: 0 });
  server = started.server;
  gateway = `http://127.0.0.1:${started.port}`;
});
afterAll(() => {
  process.env = saved;
  anthropic.close();
  gemini.close();
  server.close();
});
beforeEach(() => {
  seen.length = 0;
  resetHalts();
  setPolicy({ version: '1', agents: [{ id: 'billing', rules: [{ id: 'large-refunds', action: 'block', condition: { tool: 'refund', 'args.0.amount': { greaterThan: 100 } } }] }] });
});

async function chat(model: string, amount: number, stream: boolean) {
  const res = await fetch(`${gateway}/v1/proxy/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer provider-key', 'x-interveil-agent-id': 'billing', 'x-interveil-session-id': randomUUID() },
    body: JSON.stringify({
      model, stream,
      tools: [{ type: 'function', function: { name: 'refund', parameters: { type: 'object', properties: { amount: { type: 'number' } } } } }],
      messages: [{ role: 'system', content: 'You process refunds.' }, { role: 'user', content: `Refund ${amount} dollars` }],
    }),
  });
  const text = await res.text();
  if (!stream) {
    const message = JSON.parse(text).choices[0].message;
    return { status: res.status, content: message.content ?? '', toolArgs: message.tool_calls?.[0]?.function.arguments as string | undefined };
  }
  const chunks = text.split(/\n\n/).filter(e => e.startsWith('data: {')).map(e => JSON.parse(e.slice(6)));
  const deltas = chunks.map(c => c.choices?.[0]?.delta ?? {});
  const toolDeltas = deltas.flatMap(d => d.tool_calls ?? []);
  return {
    status: res.status,
    content: deltas.map(d => d.content ?? '').join(''),
    toolArgs: toolDeltas.length ? toolDeltas.map((t: any) => t.function?.arguments ?? '').join('') : undefined,
    done: text.trimEnd().endsWith('data: [DONE]'),
  };
}

describe.each([
  ['Anthropic', 'claude-sonnet-4-5'],
  ['Gemini', 'gemini-2.5-flash'],
])('%s through the gateway', (_name, model) => {
  it.each([false, true])('passes an allowed tool call through (stream: %s)', async (stream) => {
    const r = await chat(model, 20, stream);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.toolArgs!)).toEqual({ amount: 20 });
  });

  it.each([false, true])('withholds a blocked tool call (stream: %s)', async (stream) => {
    const r = await chat(model, 900, stream);
    expect(r.status).toBe(200);
    expect(r.toolArgs).toBeUndefined();
    expect(r.content).toContain('Refunding.');
    expect(r.content).toContain('large-refunds');
    if (stream) expect((r as { done?: boolean }).done).toBe(true);
  });
});

describe('provider requests', () => {
  it('sends Anthropic native tools and the system prompt', async () => {
    await chat('claude-sonnet-4-5', 20, false);
    expect(seen[0].body).toMatchObject({ system: 'You process refunds.', tools: [{ name: 'refund', input_schema: { type: 'object' } }] });
    expect(seen[0].headers['x-api-key']).toBe('provider-key');
  });

  it('sends the Gemini key in a header, not the URL, with the system instruction', async () => {
    await chat('gemini-2.5-flash', 20, true);
    expect(seen[0].path).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(seen[0].headers['x-goog-api-key']).toBe('provider-key');
    expect(seen[0].body.systemInstruction).toEqual({ parts: [{ text: 'You process refunds.' }] });
  });
});
