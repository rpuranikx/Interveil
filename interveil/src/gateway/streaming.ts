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
  let dropped = false;

  const req = requester.request(options, (providerRes: IncomingMessage) => {
    clientRes.setHeader('Content-Type', 'text/event-stream');
    clientRes.setHeader('Cache-Control', 'no-cache');
    clientRes.setHeader('Connection', 'keep-alive');
    clientRes.status(providerRes.statusCode ?? 200);

    providerRes.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      clientRes.write(text);

      // Parse SSE chunks to assemble full response
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
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
            // ignore parse errors on individual chunks
          }
        }
      }
    });

    providerRes.on('end', () => {
      if (!dropped) {
        onDone({ assembled, usage, finish_reason });
      }
    });

    providerRes.on('error', () => {
      if (!dropped) {
        dropped = true;
        onDone({ assembled, usage, finish_reason, partial: true });
      }
    });
  });

  req.on('error', (err) => {
    if (!clientRes.headersSent) {
      clientRes.status(502).json({
        error: { message: `Interveil Gateway: could not reach provider — ${err.message}` },
      });
    }
    dropped = true;
    onDone({ assembled, usage, finish_reason, partial: true });
  });

  clientRes.on('close', () => {
    if (!dropped) {
      dropped = true;
      req.destroy();
      onDone({ assembled, usage, finish_reason, partial: true });
    }
  });

  req.write(body);
  req.end();
}
