import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { startServer } from '../server.js';
import { store } from '../store/memory.js';
import { setPolicy } from '../policy/engine.js';
import { resetHalts } from './enforcement.js';

// ── Fake OpenAI provider ─────────────────────────────────────────────────────
// The last user message is a JSON directive: {"tool": name, "args": {...}} makes the
// model propose that tool call; anything else gets a plain text reply. With
// "legacy": true the call uses the old `function_call` field; {"choices": [...]}
// streams one directive per choice (n > 1).
interface Directive { tool?: string; args?: unknown; legacy?: boolean; choices?: Array<{ tool: string; args: unknown }> }
function directive(body: { messages: Array<{ content: string }> }): Directive {
  try { return JSON.parse(body.messages[body.messages.length - 1].content); } catch { return {}; }
}

const provider = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw);
    const { tool, args, legacy, choices } = directive(body);
    const toolCall = tool ? { id: 'call_1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } } : null;

    if (legacy && !body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl_1', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: null, function_call: { name: tool, arguments: JSON.stringify(args) } }, finish_reason: 'function_call' }],
      }));
      return;
    }
    if (legacy || choices) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (index: number, delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id: 'cmpl_1', object: 'chat.completion.chunk', model: body.model, choices: [{ index, delta, finish_reason: finish }] })}\n\n`);
      if (legacy) {
        send(0, { role: 'assistant', function_call: { name: tool, arguments: '' } });
        send(0, { function_call: { arguments: JSON.stringify(args) } });
        send(0, {}, 'function_call');
      } else {
        // Both choices use tool-call index 0, which is what used to merge them.
        choices!.forEach((c, i) => send(i, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${i}`, type: 'function', function: { name: c.tool, arguments: '' } }] }));
        choices!.forEach((c, i) => send(i, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(c.args) } }] }));
        choices!.forEach((_c, i) => send(i, {}, 'tool_calls'));
      }
      res.end('data: [DONE]\n\n');
      return;
    }

    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl_1', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: toolCall ? null : 'hi', ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (choice: object) => res.write(`data: ${JSON.stringify({ id: 'cmpl_1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`);
    send({ delta: { role: 'assistant', content: 'Let me check. ' }, finish_reason: null });
    if (toolCall) {
      const argText = toolCall.function.arguments;
      send({ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool, arguments: '' } }] }, finish_reason: null });
      // Arguments arrive in two pieces, as real providers stream them.
      send({ delta: { tool_calls: [{ index: 0, function: { arguments: argText.slice(0, 5) } }] }, finish_reason: null });
      send({ delta: { tool_calls: [{ index: 0, function: { arguments: argText.slice(5) } }] }, finish_reason: null });
      send({ delta: {}, finish_reason: 'tool_calls' });
    } else {
      send({ delta: {}, finish_reason: 'stop' });
    }
    res.end('data: [DONE]\n\n');
  });
});

// ── Fake MCP server: records what actually reaches it ────────────────────────
const mcpReceived: Array<{ method: string; params?: { name?: string } }> = [];
const mcpServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw);
    mcpReceived.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'done' }] } }));
  });
});

let gateway = '';
let gatewayServer: http.Server;
const saved = { ...process.env };

beforeAll(async () => {
  await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => mcpServer.listen(0, '127.0.0.1', r));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
  process.env.MCP_SERVER_URL = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`;
  const started = await startServer({ port: 0 });
  gatewayServer = started.server;
  gateway = `http://127.0.0.1:${started.port}`;
});

afterAll(() => {
  process.env = saved;
  provider.close();
  mcpServer.close();
  gatewayServer.close();
});

beforeEach(() => {
  resetHalts();
  mcpReceived.length = 0;
  setPolicy({
    version: '1.0',
    agents: [
      {
        id: 'billing-agent',
        rules: [
          { id: 'large-refunds', action: 'block', message: 'Refunds over $100 need a human', condition: { tool: 'refund', 'args.0.amount': { greaterThan: 100 } } },
          { id: 'audit-refunds', action: 'allow_and_audit', condition: { tool: 'refund' } },
        ],
      },
      { id: '*', rules: [{ id: 'no-drops', action: 'halt_agent', severity: 'critical', condition: { tool: 'dropDatabase' } }] },
    ],
  });
});

async function chat(agent: string, content: unknown, opts: { stream?: boolean; session?: string } = {}) {
  const session = opts.session ?? randomUUID();
  const res = await fetch(`${gateway}/v1/proxy/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test', 'x-interveil-agent-id': agent, 'x-interveil-session-id': session },
    body: JSON.stringify({
      model: 'gpt-4o', stream: opts.stream ?? false,
      tools: [{ type: 'function', function: { name: 'refund', parameters: {} } }],
      messages: [{ role: 'user', content: typeof content === 'string' ? content : JSON.stringify(content) }],
    }),
  });
  return { res, text: await res.text(), session };
}

const eventsOf = async (session: string) => {
  await new Promise(r => setTimeout(r, 20)); // stream traces are written after the response ends
  return store.getEvents(session);
};
const streamChunks = (text: string) =>
  text.split('\n\n').filter(e => e.startsWith('data: {')).map(e => JSON.parse(e.slice(6)));

describe('gateway enforcement — non-streaming', () => {
  it('withholds a tool call that a policy blocks and tells the agent why', async () => {
    const { res, text, session } = await chat('billing-agent', { tool: 'refund', args: { amount: 500 } });
    expect(res.status).toBe(200);
    const body = JSON.parse(text);
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.choices[0].message.content).toContain('large-refunds');
    expect(body.choices[0].message.content).toContain('Refunds over $100 need a human');

    const events = await eventsOf(session);
    const violation = events.find(e => e.step_type === 'POLICY_VIOLATION');
    expect(violation?.metadata).toMatchObject({ rule_id: 'large-refunds', agent_id: 'billing-agent', enforced_at: 'gateway' });
    // The trace keeps what the model actually proposed.
    const response = events.find(e => e.step_type === 'LLM_RESPONSE');
    expect(JSON.stringify(response?.output)).toContain('"refund"');
  });

  it('passes an allowed tool call through unchanged and records audit rules', async () => {
    const { text, session } = await chat('billing-agent', { tool: 'refund', args: { amount: 20 } });
    const call = JSON.parse(text).choices[0].message.tool_calls[0];
    expect(call.function).toEqual({ name: 'refund', arguments: '{"amount":20}' });
    expect((await eventsOf(session)).map(e => e.step_type)).toContain('POLICY_AUDIT');
  });

  it('applies the command blocklist to tool arguments with no policy rule involved', async () => {
    const { text, session } = await chat('any-agent', { tool: 'run_shell', args: { cmd: 'rm -rf /' } });
    const message = JSON.parse(text).choices[0].message;
    expect(message.tool_calls).toBeUndefined();
    expect(message.content).toContain('rm-recursive');
    expect((await eventsOf(session)).find(e => e.step_type === 'POLICY_VIOLATION')?.metadata?.source).toBe('blocklist');
  });

  it('leaves plain text replies alone', async () => {
    const { text } = await chat('billing-agent', 'hello');
    expect(JSON.parse(text).choices[0].message.content).toBe('hi');
  });
});

describe('gateway enforcement — streaming', () => {
  it('streams content live but replaces blocked tool-call chunks with the explanation', async () => {
    const { res, text } = await chat('billing-agent', { tool: 'refund', args: { amount: 500 } }, { stream: true });
    expect(res.status).toBe(200);
    const chunks = streamChunks(text);
    expect(chunks.some(c => c.choices[0]?.delta?.tool_calls)).toBe(false);
    const content = chunks.map(c => c.choices[0]?.delta?.content ?? '').join('');
    expect(content).toContain('Let me check. \n\n[Interveil]');
    expect(content).toContain('large-refunds');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('releases allowed tool-call chunks exactly as the provider sent them', async () => {
    const { text, session } = await chat('billing-agent', { tool: 'refund', args: { amount: 20 } }, { stream: true });
    const args = streamChunks(text).flatMap(c => c.choices[0]?.delta?.tool_calls ?? []).map((t: { function: { arguments: string } }) => t.function.arguments).join('');
    expect(args).toBe('{"amount":20}');
    const response = (await eventsOf(session)).find(e => e.step_type === 'LLM_RESPONSE');
    expect(response?.output).toMatchObject({ tool_calls: [{ name: 'refund', arguments: '{"amount":20}' }] });
  });
});

describe('halt_agent at the gateway', () => {
  it('withholds the call, then refuses every later request from that agent only', async () => {
    const first = await chat('ops-agent', { tool: 'dropDatabase', args: {} });
    expect(JSON.parse(first.text).choices[0].message.content).toContain('This agent has been halted');

    const next = await chat('ops-agent', 'hello');
    expect(next.res.status).toBe(403);
    expect((await chat('other-agent', 'hello')).res.status).toBe(200);
  });
});

describe('MCP proxy enforcement', () => {
  const mcp = (agent: string, name: string, args: unknown) => fetch(`${gateway}/v1/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-interveil-agent-id': agent },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }),
  }).then(r => r.json() as Promise<any>);

  it('never forwards a blocked tools/call and returns a tool error to the model', async () => {
    const body = await mcp('billing-agent', 'refund', { amount: 900 });
    expect(body).toMatchObject({ id: 7, result: { isError: true } });
    expect(body.result.content[0].text).toContain('large-refunds');
    expect(mcpReceived).toEqual([]);
  });

  it('forwards allowed calls', async () => {
    const body = await mcp('billing-agent', 'refund', { amount: 5 });
    expect(body.result.content[0].text).toBe('done');
    expect(mcpReceived.map(m => m.params?.name)).toEqual(['refund']);
  });

  it('refuses everything from a halted agent', async () => {
    await mcp('ops-agent', 'dropDatabase', {});
    const body = await mcp('ops-agent', 'listFiles', {});
    expect(body.error.code).toBe(-32001);
    expect(mcpReceived).toEqual([]);
  });
});

describe('session tags at the gateway', () => {
  it('carries a tag from one request to the next in the same session only', async () => {
    setPolicy({
      version: '1.0',
      agents: [{ id: 'billing-agent', rules: [
        { id: 'no-refunds-after-export', action: 'block', message: 'Customer data was exported', condition: { tool: 'refund', session: { tagged: 'exported' } } },
        { id: 'export', action: 'allow_and_audit', tag: 'exported', condition: { tool: 'export_customers' } },
      ] }],
    });
    const session = randomUUID();
    const first = await chat('billing-agent', { tool: 'export_customers', args: {} }, { session });
    expect(JSON.parse(first.text).choices[0].message.tool_calls).toHaveLength(1);
    expect((await eventsOf(session)).find(e => e.step_type === 'POLICY_AUDIT')?.metadata).toMatchObject({ tags: ['exported'] });

    const second = await chat('billing-agent', { tool: 'refund', args: { amount: 5 } }, { session });
    expect(JSON.parse(second.text).choices[0].message.content).toContain('no-refunds-after-export');
    const elsewhere = await chat('billing-agent', { tool: 'refund', args: { amount: 5 } });
    expect(JSON.parse(elsewhere.text).choices[0].message.tool_calls).toHaveLength(1);
  });
});

describe('gateway gating of legacy and multi-choice responses', () => {
  it('gates a legacy function_call, streaming or not', async () => {
    const plain = JSON.parse((await chat('any-agent', { legacy: true, tool: 'run_shell', args: { cmd: 'rm -rf ~' } })).text);
    expect(plain.choices[0].message.function_call).toBeUndefined();
    expect(plain.choices[0].message.content).toContain('rm-recursive');
    expect(plain.choices[0].finish_reason).toBe('stop');

    const streamed = streamChunks((await chat('any-agent', { legacy: true, tool: 'run_shell', args: { cmd: 'rm -rf ~' } }, { stream: true })).text);
    expect(streamed.some(c => c.choices[0]?.delta?.function_call)).toBe(false);
    expect(streamed.map(c => c.choices[0]?.delta?.content ?? '').join('')).toContain('rm-recursive');
  });

  it('keeps n > 1 choices apart and withholds a bad call in any of them', async () => {
    const { text, session } = await chat('billing-agent', { choices: [
      { tool: 'refund', args: { amount: 5 } },
      { tool: 'refund', args: { amount: 900 } },
    ] }, { stream: true });
    const chunks = streamChunks(text);
    expect(chunks.some(c => c.choices[0]?.delta?.tool_calls)).toBe(false);
    for (const i of [0, 1]) {
      const content = chunks.filter(c => c.choices[0].index === i).map(c => c.choices[0].delta?.content ?? '').join('');
      expect(content).toContain('large-refunds');
      expect(chunks.filter(c => c.choices[0].index === i).at(-1).choices[0].finish_reason).toBe('stop');
    }
    // Two separate calls were evaluated, not one merged call.
    const response = (await eventsOf(session)).find(e => e.step_type === 'LLM_RESPONSE');
    expect(response?.output).toMatchObject({ tool_calls: [{ name: 'refund', arguments: '{"amount":5}' }, { name: 'refund', arguments: '{"amount":900}' }] });
  });
});
