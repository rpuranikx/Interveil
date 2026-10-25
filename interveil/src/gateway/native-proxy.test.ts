import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { startServer } from '../server.js';
import { store } from '../store/memory.js';
import { setPolicy } from '../policy/engine.js';
import { resetHalts } from './enforcement.js';

// ── Fake providers ───────────────────────────────────────────────────────────
// The last user message is a JSON directive: {"tool": name, "args": {...}} makes the
// model propose that tool call; {"shell": [...]} (Responses only) a local_shell_call;
// anything else gets a plain text reply. Each provider remembers the last request and
// the exact stream body it sent, so tests can check passthrough byte-for-byte.

interface Directive { tool?: string; args?: unknown; shell?: string[] }
const directive = (text: unknown): Directive => {
  try { return JSON.parse(String(text)) as Directive; } catch { return {}; }
};

const last = { anthropic: { url: '', headers: {} as http.IncomingHttpHeaders, sent: '' }, openai: { url: '', headers: {} as http.IncomingHttpHeaders, sent: '' } };

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', d => (raw += d));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const anthropicProvider = http.createServer(async (req, res) => {
  const body = await readBody(req) as { stream?: boolean; messages?: Array<{ content: string }> };
  last.anthropic.url = req.url ?? '';
  last.anthropic.headers = req.headers;
  if (req.url?.startsWith('/v1/messages/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: 42 }));
    return;
  }
  const { tool, args } = directive(body.messages?.[body.messages.length - 1]?.content);

  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: tool ? 'Let me check.' : 'hi' }, ...(tool ? [{ type: 'tool_use', id: 'toolu_1', name: tool, input: args }] : [])],
      stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const argText = JSON.stringify(args ?? {});
  const events = [
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-test', usage: { input_tokens: 10, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Let me check.' } }),
    ev('content_block_stop', { index: 0 }),
    ...(tool ? [
      ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: tool, input: {} } }),
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: argText.slice(0, 5) } }),
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: argText.slice(5) } }),
      ev('content_block_stop', { index: 1 }),
    ] : []),
    ev('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }),
    ev('message_stop', {}),
  ];
  last.anthropic.sent = events.join('');
  // Split mid-event to exercise buffering.
  const all = events.join('');
  res.write(all.slice(0, 50));
  setTimeout(() => res.end(all.slice(50)), 5);
});

const responsesProvider = http.createServer(async (req, res) => {
  const body = await readBody(req) as { stream?: boolean; input?: unknown };
  last.openai.url = req.url ?? '';
  last.openai.headers = req.headers;
  const { tool, args, shell } = directive(body.input);
  const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Let me check.', annotations: [] }] };
  const call = tool
    ? { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: tool, arguments: JSON.stringify(args) }
    : shell ? { id: 'lsh_1', type: 'local_shell_call', status: 'completed', call_id: 'call_1', action: { type: 'exec', command: shell } } : null;
  const response = {
    id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-test',
    output: [message, ...(call ? [call] : [])], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };

  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let seq = 0;
  const e = (type: string, data: object) => ev(type, { ...data, sequence_number: seq++ });
  const events = [
    e('response.created', { response: { ...response, status: 'in_progress', output: [] } }),
    e('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } }),
    e('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Let me check.' }),
    e('response.output_item.done', { output_index: 0, item: message }),
    ...(call && tool ? [
      e('response.output_item.added', { output_index: 1, item: { ...call, status: 'in_progress', arguments: '' } }),
      e('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 1, delta: call.arguments!.slice(0, 5) }),
      e('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 1, delta: call.arguments!.slice(5) }),
      e('response.function_call_arguments.done', { item_id: 'fc_1', output_index: 1, arguments: call.arguments }),
      e('response.output_item.done', { output_index: 1, item: call }),
    ] : []),
    e('response.completed', { response }),
  ];
  last.openai.sent = events.join('');
  res.end(events.join(''));
});

let gateway = '';
let gatewayServer: http.Server;
const saved = { ...process.env };

beforeAll(async () => {
  await new Promise<void>(r => anthropicProvider.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => responsesProvider.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(anthropicProvider.address() as AddressInfo).port}/v1`;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(responsesProvider.address() as AddressInfo).port}/v1`;
  const started = await startServer({ port: 0 });
  gatewayServer = started.server;
  gateway = `http://127.0.0.1:${started.port}`;
});

afterAll(() => {
  process.env = saved;
  anthropicProvider.close();
  responsesProvider.close();
  gatewayServer.close();
});

beforeEach(() => {
  resetHalts();
  setPolicy({
    version: '1.0',
    agents: [
      { id: 'billing-agent', rules: [
        { id: 'large-refunds', action: 'block', message: 'Refunds over $100 need a human', condition: { tool: 'refund', 'args.0.amount': { greaterThan: 100 } } },
        { id: 'audit-refunds', action: 'allow_and_audit', condition: { tool: 'refund' } },
      ] },
      { id: '*', rules: [{ id: 'no-drops', action: 'halt_agent', condition: { tool: 'dropDatabase' } }] },
    ],
  });
});

const eventsOf = async (session: string) => {
  await new Promise(r => setTimeout(r, 30)); // stream traces are written after the response ends
  return store.getEvents(session);
};

/** Parsed `data:` payloads of an SSE body. */
const sseData = (text: string) => text.split(/\n\n/).map(e => e.split('\n').find(l => l.startsWith('data: '))).filter(Boolean).map(l => JSON.parse(l!.slice(6)));

async function messages(agent: string, content: unknown, opts: { stream?: boolean; path?: string } = {}) {
  const session = randomUUID();
  const res = await fetch(`${gateway}/v1/proxy${opts.path ?? '/messages'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-client', 'anthropic-beta': 'tools-2025', 'x-interveil-agent-id': agent, 'x-interveil-session-id': session },
    body: JSON.stringify({ model: 'claude-test', max_tokens: 100, stream: opts.stream ?? false, messages: [{ role: 'user', content: typeof content === 'string' ? content : JSON.stringify(content) }] }),
  });
  return { res, text: await res.text(), session };
}

async function respond(agent: string, input: unknown, opts: { stream?: boolean } = {}) {
  const session = randomUUID();
  const res = await fetch(`${gateway}/v1/proxy/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-client', 'x-interveil-agent-id': agent, 'x-interveil-session-id': session },
    body: JSON.stringify({ model: 'gpt-test', stream: opts.stream ?? false, input: typeof input === 'string' ? input : JSON.stringify(input) }),
  });
  return { res, text: await res.text(), session };
}

describe('POST /v1/proxy/messages (Anthropic)', () => {
  it('withholds a blocked tool_use and ends the turn with the reason', async () => {
    const { res, text, session } = await messages('billing-agent', { tool: 'refund', args: { amount: 500 } });
    expect(res.status).toBe(200);
    const body = JSON.parse(text);
    expect(body.content.map((b: { type: string }) => b.type)).toEqual(['text', 'text']);
    expect(body.content[1].text).toContain('large-refunds');
    expect(body.stop_reason).toBe('end_turn');

    const events = await eventsOf(session);
    expect(events.find(e => e.step_type === 'POLICY_VIOLATION')?.metadata).toMatchObject({ rule_id: 'large-refunds', enforced_at: 'gateway' });
    expect(JSON.stringify(events.find(e => e.step_type === 'LLM_RESPONSE')?.output)).toContain('"tool_use"');
  });

  it('passes allowed tool calls, the client key, beta header and query through', async () => {
    const { text, session } = await messages('billing-agent', { tool: 'refund', args: { amount: 20 } }, { path: '/v1/messages?beta=true' });
    expect(JSON.parse(text).content[1]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'refund', input: { amount: 20 } });
    expect(last.anthropic.url).toBe('/v1/messages?beta=true');
    expect(last.anthropic.headers).toMatchObject({ 'x-api-key': 'sk-ant-client', 'anthropic-beta': 'tools-2025', 'anthropic-version': '2023-06-01' });
    expect((await eventsOf(session)).map(e => e.step_type)).toContain('POLICY_AUDIT');
  });

  it('applies the coding-agent scoping and blocklist to Claude Code tools', async () => {
    const blocked = JSON.parse((await messages('claude-code', { tool: 'Bash', args: { command: 'rm -rf ~' } })).text);
    expect(blocked.content.at(-1).text).toContain('rm-recursive');
    const allowed = JSON.parse((await messages('claude-code', { tool: 'Write', args: { file_path: 'db/1.sql', content: 'DROP TABLE x;' } })).text);
    expect(allowed.stop_reason).toBe('tool_use');
  });

  it('streams text live and replaces a blocked tool_use block', async () => {
    const { res, text, session } = await messages('billing-agent', { tool: 'refund', args: { amount: 500 } }, { stream: true });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const data = sseData(text);
    expect(data.some(d => d.content_block?.type === 'tool_use' || d.delta?.type === 'input_json_delta')).toBe(false);
    expect(data.find(d => d.delta?.type === 'text_delta')?.delta.text).toBe('Let me check.');
    const note = data.filter(d => d.delta?.type === 'text_delta').map(d => d.delta.text).join('');
    expect(note).toContain('large-refunds');
    expect(data.find(d => d.type === 'content_block_start' && d.index === 1)?.content_block.type).toBe('text');
    expect(data.find(d => d.type === 'message_delta')).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
    expect(data.at(-1).type).toBe('message_stop');

    const response = (await eventsOf(session)).find(e => e.step_type === 'LLM_RESPONSE');
    expect(response?.output).toMatchObject({ withheld_tool_calls: true, tool_calls: [{ name: 'refund', arguments: '{"amount":500}' }] });
    expect(response?.token_usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 7 });
  });

  it('releases an allowed stream byte-for-byte', async () => {
    const { text } = await messages('billing-agent', { tool: 'refund', args: { amount: 20 } }, { stream: true });
    expect(text).toBe(last.anthropic.sent);
  });

  it('forwards count_tokens', async () => {
    const res = await fetch(`${gateway}/v1/proxy/v1/messages/count_tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-client' }, body: JSON.stringify({ model: 'claude-test', messages: [] }),
    });
    expect(await res.json()).toEqual({ input_tokens: 42 });
  });

  it('refuses a halted agent in the Anthropic error shape', async () => {
    await messages('ops-agent', { tool: 'dropDatabase', args: {} });
    const { res, text } = await messages('ops-agent', 'hello');
    expect(res.status).toBe(403);
    expect(JSON.parse(text)).toMatchObject({ type: 'error', error: { type: 'permission_error' } });
  });
});

describe('POST /v1/proxy/responses (OpenAI Responses)', () => {
  it('withholds a blocked function_call and puts the reason in a message item', async () => {
    const { text, session } = await respond('billing-agent', { tool: 'refund', args: { amount: 500 } });
    const body = JSON.parse(text);
    expect(body.output.map((i: { type: string }) => i.type)).toEqual(['message', 'message']);
    expect(body.output[1].content[0].text).toContain('large-refunds');
    expect((await eventsOf(session)).some(e => e.step_type === 'POLICY_VIOLATION')).toBe(true);
    expect(last.openai.headers.authorization).toBe('Bearer sk-client');
  });

  it('passes allowed function calls through unchanged', async () => {
    const body = JSON.parse((await respond('billing-agent', { tool: 'refund', args: { amount: 20 } })).text);
    expect(body.output[1]).toMatchObject({ type: 'function_call', name: 'refund', arguments: '{"amount":20}' });
  });

  it('gates Codex local_shell_call commands', async () => {
    const body = JSON.parse((await respond('codex', { shell: ['bash', '-lc', 'rm -rf ~'] })).text);
    expect(body.output.some((i: { type: string }) => i.type === 'local_shell_call')).toBe(false);
    expect(body.output.at(-1).content[0].text).toContain('rm-recursive');
  });

  it('streams text live and replaces a blocked function call', async () => {
    const { text, session } = await respond('billing-agent', { tool: 'refund', args: { amount: 500 } }, { stream: true });
    const data = sseData(text);
    expect(data.some(d => d.item?.type === 'function_call' || d.type?.startsWith('response.function_call_arguments'))).toBe(false);
    expect(data.filter(d => d.type === 'response.output_text.delta').map(d => d.delta)).toEqual(['Let me check.', expect.stringContaining('large-refunds')]);
    const completed = data.at(-1);
    expect(completed.type).toBe('response.completed');
    expect(completed.response.output.map((i: { type: string }) => i.type)).toEqual(['message', 'message']);
    const seqs = data.map(d => d.sequence_number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const response = (await eventsOf(session)).find(e => e.step_type === 'LLM_RESPONSE');
    expect(response?.output).toMatchObject({ withheld_tool_calls: true, tool_calls: [{ name: 'refund', arguments: '{"amount":500}' }] });
    expect(response?.token_usage).toMatchObject({ total_tokens: 15 });
  });

  it('releases an allowed stream byte-for-byte', async () => {
    const { text } = await respond('billing-agent', { tool: 'refund', args: { amount: 20 } }, { stream: true });
    expect(text).toBe(last.openai.sent);
  });
});
