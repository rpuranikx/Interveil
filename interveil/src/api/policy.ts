import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { decideToolCall, decideMethodCall, haltedBy, liftHalt } from '../gateway/enforcement.js';
import { store } from '../store/memory.js';
import { ensureSession, recordEvent } from '../store/record.js';
import { createHmac } from 'crypto';
import { activePolicyHash } from '../policy/engine.js';
import type { SecurityOptions } from '../security.js';

/**
 * POST /api/v1/policy/evaluate — asks the server's policy and command blocklist
 * whether a tool call may run, for callers that execute tools themselves: the
 * Python SDK, Claude Agent SDK / Claude Code PreToolUse hooks, or any framework.
 */
const router: Router = Router();

const EvaluateSchema = z.object({
  tool: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  /** Tool-call arguments object, evaluated as `{ args: [arguments] }` (gateway shape). */
  arguments: z.unknown().optional(),
  /** Positional method arguments, evaluated as `{ args }` (trace() shape). */
  args: z.array(z.unknown()).optional(),
  /** Records the decision in this session, and scopes session tags to it. */
  session_id: z.string().min(1).optional(),
}).strict().refine(b => !(b.arguments !== undefined && b.args !== undefined), 'send either arguments or args, not both');

router.post('/evaluate', async (req: Request, res: Response) => {
  const parsed = EvaluateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues.map(e => `${e.path.join('.') || '(body)'}: ${e.message}`).join('; ') });
  }
  const { tool, session_id: sessionId } = parsed.data;
  const agentId = parsed.data.agent_id ?? 'default';

  const haltRule = haltedBy(agentId);
  const decision = haltRule
    ? { tool, allowed: false, audit: false, halt: true, approval: false, source: 'policy' as const, ruleId: haltRule, message: 'agent is halted', arguments: parsed.data.arguments ?? parsed.data.args }
    : parsed.data.args
      ? await decideMethodCall(agentId, tool, parsed.data.args, sessionId)
      : await decideToolCall(agentId, { name: tool, arguments: parsed.data.arguments ?? {} }, sessionId);

  if (sessionId && (!decision.allowed || decision.audit)) {
    await ensureSession(sessionId, { name: `Policy API — ${agentId}`, agent_id: agentId, metadata: { source: 'policy-api' } });
    await recordEvent(sessionId, decision.allowed ? 'POLICY_AUDIT' : 'POLICY_VIOLATION', { tool_name: tool, arguments: decision.arguments }, null, {
      metadata: {
        rule_id: decision.ruleId, source: decision.source, agent_id: agentId,
        message: decision.message, halt: decision.halt, ...(decision.tags ? { tags: decision.tags } : {}), enforced_at: 'api',
      },
    });
  }

  const body = JSON.stringify({
    ok: true,
    allowed: decision.allowed,
    audit: decision.audit,
    halt: decision.halt,
    approval_required: decision.approval,
    rule_id: decision.ruleId ?? null,
    source: decision.source ?? null,
    message: decision.message ?? null,
    tags: decision.tags ?? [],
    policy_sha256: activePolicyHash(),
  });

  // Proves to the caller that this answer came from a server holding the API key, not
  // from something else listening on the port. The Claude Code hook sends a fresh
  // nonce and checks the HMAC before it trusts the decision.
  const nonce = req.headers['x-interveil-nonce'];
  const apiKey = (req.app.locals.security as SecurityOptions | undefined)?.apiKey;
  if (typeof nonce === 'string' && apiKey) res.setHeader('x-interveil-proof', evaluateProof(apiKey, nonce, body));
  return res.type('application/json').send(body);
});

/** HMAC-SHA256 over the caller's nonce and the exact response body, keyed with the API key. */
export function evaluateProof(apiKey: string, nonce: string, body: string): string {
  return createHmac('sha256', apiKey).update(`${nonce}\n${body}`).digest('hex');
}

/** GET /api/v1/policy/halts — agents currently stopped by a halt_agent rule. */
router.get('/halts', async (_req: Request, res: Response) => {
  return res.json({ ok: true, halts: await store.getHalts() });
});

/** DELETE /api/v1/policy/halts/:agentId — lifts a halt after a human has reviewed it. */
router.delete('/halts/:agentId', async (req: Request, res: Response) => {
  const lifted = await liftHalt(req.params.agentId);
  if (!lifted) return res.status(404).json({ ok: false, error: `Agent "${req.params.agentId}" is not halted` });
  return res.json({ ok: true });
});

export default router;
