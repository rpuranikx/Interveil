import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { decideToolCall, decideMethodCall, haltedBy } from '../gateway/enforcement.js';
import { ensureSession, recordEvent } from '../store/record.js';

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
  /** Records the decision in this session when given. */
  session_id: z.string().min(1).optional(),
}).strict().refine(b => !(b.arguments !== undefined && b.args !== undefined), 'send either arguments or args, not both');

router.post('/evaluate', async (req: Request, res: Response) => {
  const parsed = EvaluateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.errors.map(e => `${e.path.join('.') || '(body)'}: ${e.message}`).join('; ') });
  }
  const { tool, session_id: sessionId } = parsed.data;
  const agentId = parsed.data.agent_id ?? 'default';

  const haltRule = haltedBy(agentId);
  const decision = haltRule
    ? { tool, allowed: false, audit: false, halt: true, source: 'policy' as const, ruleId: haltRule, message: 'agent is halted', arguments: parsed.data.arguments ?? parsed.data.args }
    : parsed.data.args
      ? await decideMethodCall(agentId, tool, parsed.data.args)
      : await decideToolCall(agentId, { name: tool, arguments: parsed.data.arguments ?? {} });

  if (sessionId && (!decision.allowed || decision.audit)) {
    await ensureSession(sessionId, { name: `Policy API — ${agentId}`, agent_id: agentId, metadata: { source: 'policy-api' } });
    await recordEvent(sessionId, decision.allowed ? 'POLICY_AUDIT' : 'POLICY_VIOLATION', { tool_name: tool, arguments: decision.arguments }, null, {
      metadata: {
        rule_id: decision.ruleId, source: decision.source, agent_id: agentId,
        message: decision.message, halt: decision.halt, enforced_at: 'api',
      },
    });
  }

  return res.json({
    ok: true,
    allowed: decision.allowed,
    audit: decision.audit,
    halt: decision.halt,
    rule_id: decision.ruleId ?? null,
    source: decision.source ?? null,
    message: decision.message ?? null,
  });
});

export default router;
