import { Router, Request, Response } from 'express';
import https from 'https';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { store } from '../store/memory.js';
import { broadcast } from '../ws/broadcaster.js';
import { notifyPolicyEvent } from '../alerts/webhooks.js';
import { decideToolCall, haltedBy, withheldNote } from './enforcement.js';

const router: Router = Router();

async function emitEvent(
  sessionId: string,
  stepIndex: number,
  stepType: string,
  input: unknown,
  output: unknown,
  extra: Record<string, unknown> = {}
) {
  const event = {
    event_id: uuidv4(),
    session_id: sessionId,
    step_index: stepIndex,
    step_type: stepType,
    input,
    output,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  await store.addEvent(event as Parameters<typeof store.addEvent>[0]);
  broadcast(event);
  void notifyPolicyEvent(event as Parameters<typeof notifyPolicyEvent>[0]);
}

router.post('/', async (req: Request, res: Response) => {
  const mcpServerUrl = process.env.MCP_SERVER_URL ?? (global as Record<string, unknown>).__mcpServerUrl as string | undefined;

  if (!mcpServerUrl) {
    return res.status(503).json({
      error: 'MCP proxy not configured. Start with: interveil serve --mcp-server http://localhost:8080\nOr set MCP_SERVER_URL environment variable.',
    });
  }

  const body = req.body as { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
  const toolName = body?.params?.name ?? 'unknown';
  const toolArgs = body?.params?.arguments ?? {};

  const sessionId = (req.headers['x-interveil-session-id'] as string) ?? uuidv4();

  const session = await store.getSession(sessionId);
  if (!session) {
    await store.createSession({
      session_id: sessionId,
      name: `MCP — ${toolName} — ${new Date().toISOString()}`,
      status: 'running',
      started_at: new Date().toISOString(),
      metadata: { source: 'mcp' },
    });
  }

  const events = await store.getEvents(sessionId);
  const stepIndex = events.length;

  await emitEvent(sessionId, stepIndex, 'TOOL_CALL', {
    tool_name: toolName,
    arguments: toolArgs,
    protocol: 'mcp',
    method: body.method,
    timestamp: new Date().toISOString(),
  }, null);

  // ── Enforcement: refuse halted agents, and check tools/call before it reaches the server ──
  const agentId = (req.headers['x-interveil-agent-id'] as string | undefined) || 'default';
  const haltRule = haltedBy(agentId);
  if (haltRule) {
    const evts = await store.getEvents(sessionId);
    await emitEvent(sessionId, evts.length, 'POLICY_VIOLATION', { tool_name: toolName, method: body.method }, null, {
      metadata: { rule_id: haltRule, agent_id: agentId, halt: true, message: 'request refused: agent is halted', enforced_at: 'mcp' },
    });
    return res.json({
      jsonrpc: '2.0', id: body.id ?? null,
      error: { code: -32001, message: `Interveil: agent "${agentId}" was halted by policy rule "${haltRule}"` },
    });
  }

  if (body.method === 'tools/call') {
    const decision = await decideToolCall(agentId, { name: toolName, arguments: toolArgs });
    if (!decision.allowed || decision.audit) {
      const evts = await store.getEvents(sessionId);
      await emitEvent(sessionId, evts.length, decision.allowed ? 'POLICY_AUDIT' : 'POLICY_VIOLATION', {
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
        jsonrpc: '2.0', id: body.id ?? null,
        result: { content: [{ type: 'text', text: withheldNote([decision]) }], isError: true },
      });
    }
  }

  try {
    const parsed = new URL(mcpServerUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname || '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };

    const requester = parsed.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(req.body);

    const result = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const mcpReq = requester.request(options, (mcpRes) => {
        let data = '';
        mcpRes.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        mcpRes.on('end', () => resolve({ statusCode: mcpRes.statusCode ?? 200, body: data }));
        mcpRes.on('error', reject);
      });
      mcpReq.on('error', reject);
      mcpReq.write(bodyStr);
      mcpReq.end();
    });

    let responseJson: unknown;
    try {
      responseJson = JSON.parse(result.body);
    } catch {
      responseJson = { raw: result.body };
    }

    const evts = await store.getEvents(sessionId);
    await emitEvent(sessionId, evts.length, 'TOOL_RESULT', { tool_name: toolName }, responseJson);

    return res.status(result.statusCode).json(responseJson);
  } catch (err) {
    const evts = await store.getEvents(sessionId);
    await emitEvent(sessionId, evts.length, 'ERROR', { tool_name: toolName }, {
      message: (err as Error).message,
    });

    return res.status(503).json({
      error: `MCP server unreachable: ${(err as Error).message}`,
    });
  }
});

export default router;
