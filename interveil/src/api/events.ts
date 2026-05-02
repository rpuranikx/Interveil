import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { store } from '../store/memory.js';
import { broadcast } from '../ws/broadcaster.js';

const router = Router();

const TokenUsageSchema = z.object({
  prompt_tokens: z.number().int().optional(),
  completion_tokens: z.number().int().optional(),
  total_tokens: z.number().int().optional(),
});

const VALID_STEP_TYPES = [
  'REASONING', 'TOOL_CALL', 'TOOL_RESULT', 'LLM_REQUEST',
  'LLM_RESPONSE', 'ERROR', 'CUSTOM',
  'COMMAND_BLOCKED', 'COMMAND_DRY_RUN',
  'TOOL_PERMISSION_DENIED', 'SIDECAR_ANOMALY',
  'POLICY_VIOLATION', 'POLICY_AUDIT',
] as const;

const TraceEventSchema = z.object({
  session_id: z.string().uuid('session_id must be a uuid v4'),
  step_index: z.number().int().min(0),
  step_type: z.enum(VALID_STEP_TYPES),
  input: z.unknown(),
  output: z.unknown(),
  timestamp: z.string().datetime({ message: 'timestamp must be ISO 8601' }),
  duration_ms: z.number().int().min(0).optional(),
  token_usage: TokenUsageSchema.optional(),
  model: z.string().optional(),
  error: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = TraceEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
    });
  }

  const event_id = uuidv4();
  const event = {
    ...parsed.data,
    event_id,
    input: parsed.data.input ?? null,
    output: parsed.data.output ?? null,
  };

  // Auto-create session if it doesn't exist
  const session = await store.getSession(event.session_id);
  if (!session) {
    await store.createSession({
      session_id: event.session_id,
      status: 'running',
      started_at: event.timestamp,
    });
  }

  await store.addEvent(event);
  broadcast({ ...event });

  return res.json({ ok: true, event_id });
});

export default router;
