import { Response } from 'express';
import { IncomingMessage } from 'http';
import https from 'https';
import http from 'http';
import { ProposedToolCall } from './enforcement.js';
import { StreamTranslator } from './providers/stream-translation.js';

export interface StreamResult {
  assembled: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finish_reason?: string;
  partial?: boolean;
  /** Tool calls assembled from the stream's deltas. */
  tool_calls?: ProposedToolCall[];
  /** True when the tool calls were withheld from the client by enforcement. */
  withheld?: boolean;
}

/**
 * Called once a stream that proposed tool calls has finished, before any
 * tool-call chunk reaches the client. Return a note to withhold the tool calls
 * (the note is sent as content instead), or null to release them unchanged.
 */
export type ToolCallGate = (calls: ProposedToolCall[]) => Promise<string | null>;

/** Abort the upstream request if it sends nothing for this long. */
export const UPSTREAM_IDLE_TIMEOUT_MS = Number(process.env.INTERVEIL_UPSTREAM_TIMEOUT_MS ?? 120_000);

interface ChunkJson {
  id?: string;
  model?: string;
  created?: number;
  choices?: Array<{
    delta?: { content?: string; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Proxies an SSE request to `url` and assembles the OpenAI-format deltas for the trace.
 * Without a gate every byte is forwarded as it arrives. With a gate, content still
 * streams live, but once a tool-call delta appears the rest of the stream is held
 * until upstream finishes and the gate has decided. A translator first converts a
 * non-OpenAI provider's events (Anthropic, Gemini) into OpenAI chunks.
 * `onDone` is called exactly once: when upstream finishes, fails, or the client disconnects.
 */
export function proxyStream(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  clientRes: Response,
  onDone: (result: StreamResult) => void,
  gate?: ToolCallGate,
  translator?: StreamTranslator,
): void {
  const parsed = new URL(url);
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method,
    headers,
  };

  const requester = parsed.protocol === 'https:' ? https : http;
  let assembled = '';
  let usage: StreamResult['usage'];
  let finish_reason: string | undefined;
  let pending = '';
  let finished = false;
  const toolCalls: Array<{ name: string; arguments: string }> = [];
  let withheld = false;

  // Gate mode state
  let held: string[] | null = null; // raw events held back once tool calls appear
  let last: ChunkJson = {};

  const finish = (partial: boolean) => {
    if (finished) return;
    finished = true;
    onDone({
      assembled, usage, finish_reason,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(withheld ? { withheld: true } : {}),
      ...(partial ? { partial: true } : {}),
    });
  };

  const parseData = (line: string): ChunkJson | null => {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') return null;
    try {
      return JSON.parse(line.slice(6)) as ChunkJson;
    } catch {
      return null;
    }
  };

  const consume = (data: ChunkJson) => {
    const choice = data.choices?.[0];
    if (choice?.delta?.content) assembled += choice.delta.content;
    if (choice?.finish_reason) finish_reason = choice.finish_reason;
    for (const tc of choice?.delta?.tool_calls ?? []) {
      const i = tc.index ?? 0;
      toolCalls[i] ??= { name: '', arguments: '' };
      if (tc.function?.name) toolCalls[i].name += tc.function.name;
      if (tc.function?.arguments) toolCalls[i].arguments += tc.function.arguments;
    }
    if (data.usage) usage = data.usage;
    last = { ...last, id: data.id ?? last.id, model: data.model ?? last.model, created: data.created ?? last.created };
  };

  const write = (text: string) => {
    if (!clientRes.writableEnded) clientRes.write(text);
  };

  // Gate mode: one complete SSE event (without its trailing blank line).
  const onEvent = (event: string) => {
    const dataLine = event.split('\n').map(l => l.replace(/\r$/, '')).find(l => l.startsWith('data: '));
    const data = dataLine ? parseData(dataLine) : null;
    if (data) consume(data);
    if (data?.choices?.[0]?.delta?.tool_calls) held ??= [];
    if (held) held.push(event);
    else write(`${event}\n\n`);
  };

  const synthesized = (note: string): string[] => {
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({ id: last.id, object: 'chat.completion.chunk', created: last.created, model: last.model, choices: [{ index: 0, delta, finish_reason: finish }] })}`;
    // Keep a trailing usage-only chunk (stream_options.include_usage) if upstream sent one.
    const usageEvents = (held ?? []).filter(e => {
      const d = parseData(e.split('\n').find(l => l.startsWith('data: ')) ?? '');
      return !!d?.usage && (d.choices ?? []).length === 0;
    });
    // Separate the note from any text the model already streamed, as the non-streaming path does.
    return [chunk({ content: (assembled ? '\n\n' : '') + note }, null), chunk({}, 'stop'), ...usageEvents, 'data: [DONE]'];
  };

  const flushHeld = async () => {
    if (!held) return;
    const calls = toolCalls.filter(Boolean);
    const note = gate && calls.length > 0 ? await gate(calls) : null;
    const events = note ? synthesized(note) : held;
    if (note) {
      withheld = true;
      finish_reason = 'stop';
    }
    for (const e of events) write(`${e}\n\n`);
    held = null;
  };

  const req = requester.request(options, (providerRes: IncomingMessage) => {
    const ok = (providerRes.statusCode ?? 200) < 400;
    const gated = (!!gate || !!translator) && ok;
    clientRes.status(providerRes.statusCode ?? 200);
    // Translated streams are always SSE; upstream errors (JSON) pass through with their own content type.
    clientRes.setHeader('Content-Type', translator && ok ? 'text/event-stream' : providerRes.headers['content-type'] ?? 'text/event-stream');
    clientRes.setHeader('Cache-Control', 'no-cache');
    clientRes.setHeader('Connection', 'keep-alive');
    clientRes.flushHeaders();
    const handle = (event: string) => {
      if (!translator) return onEvent(event);
      for (const out of translator.event(event)) onEvent(out);
    };

    providerRes.on('data', (chunk: Buffer) => {
      if (gated) {
        // SSE events are separated by a blank line and can be split across TCP chunks.
        const events = (pending + chunk.toString()).split(/\r?\n\r?\n/);
        pending = events.pop() ?? '';
        for (const event of events) if (event.trim()) handle(event);
        return;
      }
      write(chunk.toString());
      const lines = (pending + chunk.toString()).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const data = parseData(line.replace(/\r$/, ''));
        if (data) consume(data);
      }
    });

    providerRes.on('end', async () => {
      if (gated) {
        if (pending.trim()) handle(pending);
        for (const out of translator?.end() ?? []) onEvent(out);
        await flushHeld();
      } else if (pending) {
        const data = parseData(pending.replace(/\r$/, ''));
        if (data) consume(data);
      }
      clientRes.end();
      finish(false);
    });

    providerRes.on('error', () => {
      // Never release held tool calls from a broken stream.
      held = null;
      clientRes.end();
      finish(true);
    });
  });

  req.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
    req.destroy(new Error(`upstream sent nothing for ${UPSTREAM_IDLE_TIMEOUT_MS} ms`));
  });

  req.on('error', (err) => {
    if (!clientRes.headersSent) {
      clientRes.status(502).json({
        error: { message: `Interveil Gateway: could not reach provider — ${err.message}` },
      });
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

  req.write(body);
  req.end();
}
