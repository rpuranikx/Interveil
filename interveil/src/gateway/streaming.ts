import { Response } from 'express';
import { IncomingMessage } from 'http';
import https from 'https';
import http from 'http';

export interface StreamResult {
  assembled: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finish_reason?: string;
  partial?: boolean;
}

/** Abort the upstream request if it sends nothing for this long. */
export const UPSTREAM_IDLE_TIMEOUT_MS = Number(process.env.INTERVEIL_UPSTREAM_TIMEOUT_MS ?? 120_000);

/**
 * Proxies an SSE request to `url`, forwarding every byte to `clientRes` as it
 * arrives and assembling the OpenAI-format deltas for the trace.
 * `onDone` is called exactly once: when upstream finishes, fails, or the client disconnects.
 */
export function proxyStream(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  clientRes: Response,
  onDone: (result: StreamResult) => void
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

  const finish = (partial: boolean) => {
    if (finished) return;
    finished = true;
    onDone({ assembled, usage, finish_reason, ...(partial ? { partial: true } : {}) });
  };

  const consumeLine = (line: string) => {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') return;
    try {
      const data = JSON.parse(line.slice(6)) as {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      const delta = data.choices?.[0]?.delta?.content;
      if (delta) assembled += delta;
      if (data.choices?.[0]?.finish_reason) finish_reason = data.choices[0].finish_reason;
      if (data.usage) usage = data.usage;
    } catch {
      // ignore non-JSON data lines
    }
  };

  const req = requester.request(options, (providerRes: IncomingMessage) => {
    clientRes.status(providerRes.statusCode ?? 200);
    // Pass upstream errors (JSON) through with their own content type.
    clientRes.setHeader('Content-Type', providerRes.headers['content-type'] ?? 'text/event-stream');
    clientRes.setHeader('Cache-Control', 'no-cache');
    clientRes.setHeader('Connection', 'keep-alive');
    clientRes.flushHeaders();

    providerRes.on('data', (chunk: Buffer) => {
      if (!clientRes.writableEnded) clientRes.write(chunk);

      // SSE lines can be split across TCP chunks — keep the unfinished tail for the next chunk.
      const lines = (pending + chunk.toString()).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) consumeLine(line.replace(/\r$/, ''));
    });

    providerRes.on('end', () => {
      if (pending) consumeLine(pending.replace(/\r$/, ''));
      clientRes.end();
      finish(false);
    });

    providerRes.on('error', () => {
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
