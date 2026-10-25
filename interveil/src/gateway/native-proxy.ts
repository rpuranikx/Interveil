import { Router, Request, Response } from 'express';
import https from 'https';
import http from 'http';
import { recordEvent } from '../store/record.js';
import { keyMatches } from '../security.js';
import { resolveAuth } from './auth.js';
import { ANTHROPIC_BASE } from './providers/anthropic.js';
import { openAIUrl } from './providers/openai.js';
import { ProposedToolCall } from './enforcement.js';
import { gateToolCalls, gatewayContext, GatewayContext, trackRequest } from './gate.js';
import { UPSTREAM_IDLE_TIMEOUT_MS } from './streaming.js';

/**
 * Native-format gateway routes. Unlike /chat/completions these are not
 * translated: requests and responses keep the provider's own shape, so clients
 * built on that API (Claude Code on the Anthropic Messages API, Codex on the
 * OpenAI Responses API) can point their base URL here.
 *
 * Tool calls are gated the same way as on /chat/completions. If any is
 * disallowed, everything from the first tool call on is replaced by a text
 * note naming the rules, and the response ends as a normal turn, so the client
 * has nothing to execute. When streaming, text before the first tool call is
 * forwarded live; from the first tool call on, events are held until upstream
 * finishes and the gate has decided, then released byte-for-byte or replaced.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- provider payloads are open-ended JSON */
type Json = Record<string, any>;

interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number }

interface StreamState {
  /** Updates the trace summary and tool calls from one event's data. */
  consume(data: Json): void;
  /** True for the event that opens the first tool call: it and everything after are held. */
  startsHold(data: Json): boolean;
  calls(): ProposedToolCall[];
  assembled: string;
  usage?: Usage;
  stopReason?: string;
  /** SSE events (without the trailing blank line) to send instead of the held ones. */
  replacement(held: Json[], note: string): string[];
}

interface NativeFormat {
  api: string;
  upstreamUrl(req: Request): string;
  /** Provider auth plus pass-through headers, or null when there is no provider key. */
  upstreamHeaders(req: Request): Record<string, string> | null;
  errorBody(message: string, type: string): object;
  toolCalls(response: Json): ProposedToolCall[];
  withhold(response: Json, note: string): Json;
  usage(response: Json): Usage | undefined;
  newStream(): StreamState;
}

const sse = (type: string, data: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}`;

const copy = (v: Json): Json => JSON.parse(JSON.stringify(v)) as Json;

const queryOf = (req: Request) => {
  const i = req.originalUrl.indexOf('?');
  return i === -1 ? '' : req.originalUrl.slice(i);
};

const usageOf = (input: number, output: number): Usage => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output });

// ── Anthropic Messages ───────────────────────────────────────────────────────

const anthropic: NativeFormat = {
  api: 'anthropic-messages',

  upstreamUrl: (req) => {
    const suffix = req.path.endsWith('/count_tokens') ? '/messages/count_tokens' : '/messages';
    return `${(process.env.ANTHROPIC_BASE_URL || ANTHROPIC_BASE).replace(/\/$/, '')}${suffix}${queryOf(req)}`;
  },

  upstreamHeaders: (req) => {
    const security = req.app.locals.security;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
    };
    const beta = req.headers['anthropic-beta'];
    if (typeof beta === 'string') headers['anthropic-beta'] = beta;

    // Anthropic clients send their key as x-api-key, or an OAuth token as a bearer.
    const xKey = req.headers['x-api-key'];
    if (typeof xKey === 'string' && xKey && !(security?.apiKey && keyMatches(xKey, security.apiKey))) {
      return { ...headers, 'x-api-key': xKey };
    }
    const auth = resolveAuth(req, 'anthropic', security);
    if (auth.mode === 'passthrough') return { ...headers, Authorization: `Bearer ${auth.key}` };
    if (auth.key) return { ...headers, 'x-api-key': auth.key };
    return null;
  },

  errorBody: (message, type) => ({ type: 'error', error: { type, message } }),

  toolCalls: (response) => ((response.content ?? []) as Json[])
    .filter(b => b.type === 'tool_use')
    .map(b => ({ name: b.name ?? '', arguments: b.input ?? {} })),

  withhold: (response, note) => {
    const out = copy(response);
    const content = (out.content ?? []) as Json[];
    const first = content.findIndex(b => b.type === 'tool_use');
    out.content = [...content.slice(0, first), { type: 'text', text: note }];
    out.stop_reason = 'end_turn';
    out.stop_sequence = null;
    return out;
  },

  usage: (response) => {
    const u = response.usage as Json | undefined;
    if (!u) return undefined;
    return usageOf((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), u.output_tokens ?? 0);
  },

  newStream: () => {
    const tools = new Map<number, { name: string; json: string; input: unknown }>();
    let input = 0;
    let output = 0;
    const state: StreamState = {
      assembled: '',
      consume(data) {
        if (data.type === 'message_start') {
          const u = data.message?.usage ?? {};
          input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          output = u.output_tokens ?? 0;
        } else if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
          tools.set(data.index, { name: data.content_block.name ?? '', json: '', input: data.content_block.input });
        } else if (data.type === 'content_block_delta') {
          if (data.delta?.type === 'text_delta') state.assembled += data.delta.text ?? '';
          const tool = tools.get(data.index);
          if (tool && data.delta?.type === 'input_json_delta') tool.json += data.delta.partial_json ?? '';
        } else if (data.type === 'message_delta') {
          if (data.delta?.stop_reason) state.stopReason = data.delta.stop_reason;
          if (data.usage?.output_tokens !== undefined) output = data.usage.output_tokens;
        }
        state.usage = usageOf(input, output);
      },
      startsHold: (data) => data.type === 'content_block_start' && data.content_block?.type === 'tool_use',
      calls: () => [...tools.values()].map(t => ({ name: t.name, arguments: t.json || t.input || {} })),
      replacement(held, note) {
        const index = held.find(d => d.type === 'content_block_start')?.index ?? 0;
        const usage = held.find(d => d.type === 'message_delta')?.usage ?? { output_tokens: output };
        state.stopReason = 'end_turn';
        return [
          sse('content_block_start', { index, content_block: { type: 'text', text: '' } }),
          sse('content_block_delta', { index, delta: { type: 'text_delta', text: note } }),
          sse('content_block_stop', { index }),
          sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }),
          sse('message_stop', {}),
        ];
      },
    };
    return state;
  },
};

// ── OpenAI Responses ─────────────────────────────────────────────────────────

/** Output items the client executes. Server-side tools (web search, remote MCP) have already run. */
const CLIENT_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'shell_call', 'apply_patch_call', 'computer_call']);

const isClientCall = (item: Json | undefined) => !!item && CLIENT_CALLS.has(item.type);

function itemCall(item: Json): ProposedToolCall {
  const args = item.arguments ?? (item.input !== undefined ? { input: item.input } : item.action ?? item.operation ?? {});
  return { name: item.name ?? item.type, arguments: args };
}

const noteItem = (note: string, status: string) => ({
  id: 'msg_interveil', type: 'message', role: 'assistant', status,
  content: status === 'completed' ? [{ type: 'output_text', text: note, annotations: [] }] : [],
});

const terminal = (type: string | undefined) => type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed';

const responses: NativeFormat = {
  api: 'openai-responses',

  upstreamUrl: (req) => openAIUrl('/responses') + queryOf(req),

  upstreamHeaders: (req) => {
    const auth = resolveAuth(req, 'openai', req.app.locals.security);
    if (!auth.key) return null;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.key}` };
    for (const name of ['openai-organization', 'openai-project', 'openai-beta']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    return headers;
  },

  errorBody: (message, type) => ({ error: { message, type } }),

  toolCalls: (response) => ((response.output ?? []) as Json[]).filter(isClientCall).map(itemCall),

  withhold: (response, note) => {
    const out = copy(response);
    const items = (out.output ?? []) as Json[];
    const first = items.findIndex(isClientCall);
    out.output = [...items.slice(0, first), noteItem(note, 'completed')];
    if (typeof out.output_text === 'string') out.output_text = note;
    return out;
  },

  usage: (response) => {
    const u = response.usage as Json | undefined;
    return u ? usageOf(u.input_tokens ?? 0, u.output_tokens ?? 0) : undefined;
  },

  newStream: () => {
    const items = new Map<number, Json>();
    let seq = 0;
    const state: StreamState = {
      assembled: '',
      consume(data) {
        if (typeof data.sequence_number === 'number') seq = data.sequence_number;
        if (data.type === 'response.output_text.delta') state.assembled += data.delta ?? '';
        if ((data.type === 'response.output_item.added' || data.type === 'response.output_item.done') && isClientCall(data.item)) {
          items.set(data.output_index, copy(data.item));
        }
        if (data.type === 'response.function_call_arguments.delta') {
          const item = items.get(data.output_index);
          if (item) item.arguments = (item.arguments ?? '') + (data.delta ?? '');
        }
        if (terminal(data.type)) {
          state.stopReason = data.response?.status;
          state.usage = responses.usage(data.response ?? {});
        }
      },
      startsHold: (data) => data.type === 'response.output_item.added' && isClientCall(data.item),
      calls: () => [...items.values()].map(itemCall),
      replacement(held, note) {
        const output_index = held.find(d => d.type === 'response.output_item.added')?.output_index ?? 0;
        let n = held[0]?.sequence_number ?? seq;
        const ev = (type: string, data: Json) => sse(type, { ...data, sequence_number: n++ });
        const item_id = 'msg_interveil';
        const part = (text: string) => ({ type: 'output_text', text, annotations: [] });
        const events = [
          ev('response.output_item.added', { output_index, item: noteItem(note, 'in_progress') }),
          ev('response.content_part.added', { item_id, output_index, content_index: 0, part: part('') }),
          ev('response.output_text.delta', { item_id, output_index, content_index: 0, delta: note }),
          ev('response.output_text.done', { item_id, output_index, content_index: 0, text: note }),
          ev('response.content_part.done', { item_id, output_index, content_index: 0, part: part(note) }),
          ev('response.output_item.done', { output_index, item: noteItem(note, 'completed') }),
        ];
        const end = held.find(d => terminal(d.type));
        if (end) {
          const { type, sequence_number: _seq, ...rest } = end;
          events.push(ev(type, { ...rest, response: responses.withhold(end.response ?? {}, note) }));
        }
        return events;
      },
    };
    return state;
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Upstream plumbing ────────────────────────────────────────────────────────

function upstreamRequest(url: string, headers: Record<string, string>, onResponse: (res: http.IncomingMessage) => void): http.ClientRequest {
  const parsed = new URL(url);
  const requester = parsed.protocol === 'https:' ? https : http;
  const req = requester.request({
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'POST',
    headers,
  }, onResponse);
  req.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => req.destroy(new Error(`upstream sent nothing for ${UPSTREAM_IDLE_TIMEOUT_MS} ms`)));
  return req;
}

function postJson(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = upstreamRequest(url, headers, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 200, body: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

interface NativeStreamResult {
  assembled: string;
  usage?: Usage;
  stopReason?: string;
  toolCalls: ProposedToolCall[];
  withheld: boolean;
  partial: boolean;
  status: number;
}

/** Streams an SSE response through, holding everything from the first tool call until the gate decides. */
function proxyNativeStream(
  url: string, headers: Record<string, string>, body: string, clientRes: Response,
  state: StreamState, gate: (calls: ProposedToolCall[]) => Promise<string | null>,
  onDone: (result: NativeStreamResult) => void,
): void {
  let held: Array<{ raw: string; data: Json }> | null = null;
  let pending = '';
  let finished = false;
  let withheld = false;
  let status = 200;

  const finish = (partial: boolean) => {
    if (finished) return;
    finished = true;
    onDone({ assembled: state.assembled, usage: state.usage, stopReason: state.stopReason, toolCalls: state.calls(), withheld, partial, status });
  };
  const write = (text: string) => {
    if (!clientRes.writableEnded) clientRes.write(text);
  };

  const onEvent = (raw: string) => {
    const dataLine = raw.split('\n').map(l => l.replace(/\r$/, '')).find(l => l.startsWith('data:'));
    let data: Json = {};
    try {
      if (dataLine) data = JSON.parse(dataLine.slice(5).trim()) as Json;
    } catch { /* not JSON (e.g. a comment): forward or hold as-is */ }
    state.consume(data);
    if (!held && state.startsHold(data)) held = [];
    if (held) held.push({ raw, data });
    else write(`${raw}\n\n`);
  };

  const req = upstreamRequest(url, headers, (providerRes) => {
    status = providerRes.statusCode ?? 200;
    const ok = status < 400;
    clientRes.status(status);
    clientRes.setHeader('Content-Type', providerRes.headers['content-type'] ?? 'text/event-stream');
    clientRes.setHeader('Cache-Control', 'no-cache');
    clientRes.flushHeaders();

    providerRes.on('data', (chunk: Buffer) => {
      if (!ok) return write(chunk.toString()); // provider errors pass through untouched
      const events = (pending + chunk.toString()).split(/\r?\n\r?\n/);
      pending = events.pop() ?? '';
      for (const event of events) if (event.trim()) onEvent(event);
    });

    providerRes.on('end', async () => {
      if (ok && pending.trim()) onEvent(pending);
      if (held) {
        const events = held as Array<{ raw: string; data: Json }>;
        held = null;
        const calls = state.calls();
        const note = calls.length > 0 ? await gate(calls) : null;
        if (note) withheld = true;
        const out = note ? state.replacement(events.map(e => e.data), note) : events.map(e => e.raw);
        for (const e of out) write(`${e}\n\n`);
      }
      clientRes.end();
      finish(false);
    });

    providerRes.on('error', () => {
      held = null; // never release tool calls from a broken stream
      clientRes.end();
      finish(true);
    });
  });

  req.on('error', (err) => {
    if (!clientRes.headersSent) {
      clientRes.status(502).json({ error: { message: `Interveil Gateway: could not reach provider — ${err.message}` } });
    } else {
      clientRes.end();
    }
    finish(true);
  });

  clientRes.on('close', () => {
    if (!finished) {
      req.destroy();
      finish(true);
    }
  });

  req.end(body);
}

// ── Routes ───────────────────────────────────────────────────────────────────

async function handle(req: Request, res: Response, format: NativeFormat): Promise<void> {
  const body = (req.body ?? {}) as Json;
  const model = typeof body.model === 'string' ? body.model : 'unknown';
  const startTime = Date.now();

  const headers = format.upstreamHeaders(req);
  if (!headers) {
    res.status(401).json(format.errorBody('Interveil Gateway: No provider API key found. Send your own key, or set ANTHROPIC_API_KEY / OPENAI_API_KEY on the server.', 'authentication_error'));
    return;
  }

  const ctx = await gatewayContext(req, res, model, (message) => format.errorBody(message, 'permission_error'));
  if (!ctx) return;
  const { sessionId, agentId }: GatewayContext = ctx;

  await recordEvent(sessionId, 'LLM_REQUEST', {
    model,
    api: format.api,
    ...(body.system !== undefined ? { system: body.system } : {}),
    ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
    ...(body.messages !== undefined ? { messages: body.messages } : {}),
    ...(body.input !== undefined ? { input: body.input } : {}),
    tools: body.tools,
    source: 'gateway',
  }, null, { model, timestamp: new Date().toISOString() });

  const url = format.upstreamUrl(req);
  const gate = (calls: ProposedToolCall[]) => gateToolCalls(sessionId, agentId, calls);

  if (body.stream === true) {
    proxyNativeStream(url, headers, JSON.stringify(body), res, format.newStream(), gate, async (result) => {
      const duration_ms = Date.now() - startTime;
      await recordEvent(sessionId, result.status >= 400 ? 'ERROR' : 'LLM_RESPONSE', null, {
        api: format.api,
        content: result.assembled,
        stop_reason: result.stopReason,
        ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
        ...(result.withheld ? { withheld_tool_calls: true } : {}),
        ...(result.partial ? { partial: true } : {}),
      }, { model, duration_ms, token_usage: result.usage, timestamp: new Date().toISOString() });
      trackRequest(model, result.usage?.total_tokens ?? 0, duration_ms);
    });
    return;
  }

  try {
    const upstream = await postJson(url, headers, JSON.stringify(body));
    const duration_ms = Date.now() - startTime;
    let json: Json;
    try {
      json = JSON.parse(upstream.body) as Json;
    } catch {
      res.status(502).json(format.errorBody('Interveil Gateway: invalid response from provider', 'api_error'));
      return;
    }
    if (upstream.status >= 400) {
      await recordEvent(sessionId, 'ERROR', { status: upstream.status }, json, { model, duration_ms, timestamp: new Date().toISOString() });
      res.status(upstream.status).json(json);
      return;
    }

    const usage = format.usage(json);
    // The trace records what the model proposed; the client gets the enforced response.
    await recordEvent(sessionId, 'LLM_RESPONSE', null, json, { model, duration_ms, token_usage: usage, timestamp: new Date().toISOString() });
    const calls = format.toolCalls(json);
    const note = calls.length > 0 ? await gate(calls) : null;
    trackRequest(model, usage?.total_tokens ?? 0, duration_ms);
    res.json(note ? format.withhold(json, note) : json);
  } catch (err) {
    await recordEvent(sessionId, 'ERROR', null, { message: (err as Error).message }, {
      model, duration_ms: Date.now() - startTime, timestamp: new Date().toISOString(),
    });
    if (!res.headersSent) {
      res.status(502).json(format.errorBody(`Interveil Gateway: could not reach provider — ${(err as Error).message}`, 'api_error'));
    }
  }
}

/** Token counting proposes no tool calls, so it is forwarded without gating or tracing. */
async function countTokens(req: Request, res: Response): Promise<void> {
  const headers = anthropic.upstreamHeaders(req);
  if (!headers) {
    res.status(401).json(anthropic.errorBody('Interveil Gateway: No provider API key found.', 'authentication_error'));
    return;
  }
  try {
    const upstream = await postJson(anthropic.upstreamUrl(req), headers, JSON.stringify(req.body ?? {}));
    res.status(upstream.status).type('application/json').send(upstream.body);
  } catch (err) {
    res.status(502).json(anthropic.errorBody(`Interveil Gateway: could not reach provider — ${(err as Error).message}`, 'api_error'));
  }
}

const router: Router = Router();

// The Anthropic SDK appends /v1/messages to its base URL, so with
// ANTHROPIC_BASE_URL=http://127.0.0.1:3000/v1/proxy requests arrive at /v1/messages.
router.post(['/messages/count_tokens', '/v1/messages/count_tokens'], countTokens);
router.post(['/messages', '/v1/messages'], (req, res) => handle(req, res, anthropic));
router.post('/responses', (req, res) => handle(req, res, responses));

export default router;
