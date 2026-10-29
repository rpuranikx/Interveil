import { Router, Request, Response } from 'express';
import https from 'https';
import http from 'http';
import { IncomingMessage } from 'http';
import { ensureSession, recordEvent } from '../store/record.js';
import { decideToolCall, haltedBy, withheldNote } from './enforcement.js';
import { UPSTREAM_IDLE_TIMEOUT_MS } from './streaming.js';

/**
 * MCP proxy for the Streamable HTTP transport. JSON-RPC messages POSTed to
 * /v1/mcp are forwarded to one upstream MCP server with the transport headers
 * (Accept, Mcp-Session-Id, MCP-Protocol-Version); JSON and SSE responses are
 * passed back unchanged. Every tools/call is checked against the blocklist and
 * policy first, and a blocked call never reaches the server.
 */

const router: Router = Router();

const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: unknown };
  result?: unknown;
  error?: unknown;
}

function upstreamUrl(): string | undefined {
  return process.env.MCP_SERVER_URL ?? (global as Record<string, unknown>).__mcpServerUrl as string | undefined;
}

/** Groups calls by the caller's session header, else the MCP session, else by day. */
async function resolveSession(req: Request): Promise<string> {
  const explicit = req.headers['x-interveil-session-id'] as string | undefined;
  const mcpSession = req.headers['mcp-session-id'] as string | undefined;
  const sessionId = explicit ?? (mcpSession ? `mcp-${mcpSession}` : `mcp-proxy-${new Date().toISOString().split('T')[0]}`);
  await ensureSession(sessionId, { name: `MCP — ${new Date().toISOString()}`, metadata: { source: 'mcp', badge: 'MCP' } });
  return sessionId;
}

/** Forwards the request and relays the response; resolves with the JSON-RPC reply when one can be read. */
function forward(target: string, req: Request, res: Response, body: string | null): Promise<JsonRpcMessage | null> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target);
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    headers.accept ??= 'application/json, text/event-stream';
    if (body !== null) headers['content-type'] = 'application/json';

    const requester = parsed.protocol === 'https:' ? https : http;
    const upstream = requester.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers,
    }, (upstreamRes: IncomingMessage) => {
      res.status(upstreamRes.statusCode ?? 200);
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstreamRes.headers[name];
        if (value !== undefined) res.setHeader(name, value);
      }

      const isSse = String(upstreamRes.headers['content-type'] ?? '').includes('text/event-stream');
      let raw = '';
      let reply: JsonRpcMessage | null = null;
      upstreamRes.on('data', (chunk: Buffer) => {
        res.write(chunk);
        raw += chunk.toString();
        if (isSse && !reply) {
          // Pick the JSON-RPC response out of the event stream for the trace.
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const msg = JSON.parse(line.slice(6)) as JsonRpcMessage;
              if ('result' in msg || 'error' in msg) reply = msg;
            } catch {
              // partial line; wait for more data
            }
          }
        }
      });
      upstreamRes.on('end', () => {
        res.end();
        if (!isSse && raw) {
          try { reply = JSON.parse(raw) as JsonRpcMessage; } catch { reply = null; }
        }
        resolve(reply);
      });
      upstreamRes.on('error', reject);
    });

    upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => upstream.destroy(new Error('MCP server timed out')));
    upstream.on('error', reject);
    res.on('close', () => upstream.destroy());
    upstream.end(body ?? undefined);
  });
}

router.post('/', async (req: Request, res: Response) => {
  const target = upstreamUrl();
  if (!target) {
    return res.status(503).json({
      error: 'MCP proxy not configured. Start with: interveil serve --mcp-server http://localhost:8080/mcp\nOr set MCP_SERVER_URL environment variable.',
    });
  }

  if (Array.isArray(req.body)) {
    // Batches would let one tools/call ride along unchecked; MCP 2025-06-18 dropped them anyway.
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Interveil: JSON-RPC batches are not supported' } });
  }

  const message = req.body as JsonRpcMessage;
  const isToolCall = message.method === 'tools/call';
  const toolName = message.params?.name ?? 'unknown';
  const toolArgs = message.params?.arguments ?? {};
  const sessionId = await resolveSession(req);
  const agentId = (req.headers['x-interveil-agent-id'] as string | undefined) || 'default';

  if (isToolCall) {
    await recordEvent(sessionId, 'TOOL_CALL', { tool_name: toolName, arguments: toolArgs, protocol: 'mcp' }, null, {
      metadata: { agent_id: agentId },
    });
  } else if (message.method) {
    await recordEvent(sessionId, 'CUSTOM', { protocol: 'mcp', method: message.method }, null);
  }

  // A tools/call without an id is a notification, which JSON-RPC forbids for calls that
  // return results. Refuse it rather than let the halt and policy checks see a request
  // the upstream server might still execute.
  if (isToolCall && (message.id === undefined || message.id === null)) {
    await recordEvent(sessionId, 'POLICY_VIOLATION', { tool_name: toolName, arguments: toolArgs }, null, {
      metadata: { rule_id: 'mcp-call-without-id', agent_id: agentId, message: 'tools/call without an id refused', enforced_at: 'mcp' },
    });
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Interveil: tools/call must have an id' } });
  }

  // ── Enforcement: refuse halted agents, and check tools/call before it reaches the server ──
  const haltRule = haltedBy(agentId);
  if (haltRule && message.id !== undefined) {
    await recordEvent(sessionId, 'POLICY_VIOLATION', { tool_name: toolName, method: message.method }, null, {
      metadata: { rule_id: haltRule, agent_id: agentId, halt: true, message: 'request refused: agent is halted', enforced_at: 'mcp' },
    });
    return res.json({
      jsonrpc: '2.0', id: message.id,
      error: { code: -32001, message: `Interveil: agent "${agentId}" was halted by policy rule "${haltRule}"` },
    });
  }

  if (isToolCall) {
    const decision = await decideToolCall(agentId, { name: toolName, arguments: toolArgs }, sessionId);
    if (!decision.allowed || decision.audit) {
      await recordEvent(sessionId, decision.allowed ? 'POLICY_AUDIT' : 'POLICY_VIOLATION', {
        tool_name: toolName,
        arguments: toolArgs,
      }, null, {
        metadata: {
          rule_id: decision.ruleId, source: decision.source, agent_id: agentId,
          message: decision.message, halt: decision.halt, enforced_at: 'mcp',
        },
      });
    }
    if (!decision.allowed) {
      // A tool-level error (not a protocol error), so the model sees why the call failed.
      return res.json({
        jsonrpc: '2.0', id: message.id ?? null,
        result: { content: [{ type: 'text', text: withheldNote([decision]) }], isError: true },
      });
    }
  }

  try {
    const reply = await forward(target, req, res, JSON.stringify(req.body));
    if (isToolCall) {
      await recordEvent(sessionId, reply?.error ? 'ERROR' : 'TOOL_RESULT', { tool_name: toolName }, reply?.result ?? reply?.error ?? null);
    }
  } catch (err) {
    await recordEvent(sessionId, 'ERROR', { tool_name: toolName, method: message.method }, { message: (err as Error).message });
    if (!res.headersSent) {
      res.status(503).json({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: `MCP server unreachable: ${(err as Error).message}` } });
    }
  }
});

// Session termination is passed through. Server-initiated streams (GET) are not proxied;
// 405 is the spec's way of saying so, and clients fall back to POST-only.
router.delete('/', async (req: Request, res: Response) => {
  const target = upstreamUrl();
  if (!target) return res.status(503).end();
  try {
    await forward(target, req, res, null);
  } catch {
    if (!res.headersSent) res.status(503).end();
  }
});

router.get('/', (_req: Request, res: Response) => {
  res.status(405).setHeader('Allow', 'POST, DELETE').end();
});

export default router;
