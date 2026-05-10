import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { store } from '../store/memory.js';

const router: Router = Router();

const CreateSessionSchema = z.object({
  session_id: z.string().uuid('session_id must be a uuid v4'),
  name: z.string().optional(),
  agent_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const UpdateSessionSchema = z.object({
  status: z.enum(['completed', 'failed']),
  ended_at: z.string().datetime({ message: 'ended_at must be ISO 8601' }),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = CreateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
    });
  }

  const { session_id, name, agent_id, metadata } = parsed.data;

  const existing = await store.getSession(session_id);
  if (!existing) {
    await store.createSession({
      session_id,
      name,
      agent_id,
      metadata,
      status: 'running',
      started_at: new Date().toISOString(),
    });
  }

  return res.json({ ok: true, session_id });
});

router.patch('/:session_id', async (req: Request, res: Response) => {
  const { session_id } = req.params;
  const parsed = UpdateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
    });
  }

  const session = await store.getSession(session_id);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  await store.updateSession(session_id, {
    status: parsed.data.status,
    ended_at: parsed.data.ended_at,
  });

  return res.json({ ok: true });
});

router.get('/', async (_req: Request, res: Response) => {
  const sessions = await store.getAllSessions();
  return res.json({ ok: true, sessions });
});

router.get('/:session_id', async (req: Request, res: Response) => {
  const session = await store.getSession(req.params.session_id);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }
  return res.json({ ok: true, session });
});

router.get('/:session_id/events', async (req: Request, res: Response) => {
  const session = await store.getSession(req.params.session_id);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }
  const events = await store.getEvents(req.params.session_id);
  return res.json({ ok: true, events });
});

export default router;
