import { Router, Request, Response } from 'express';
import { getAgentGraph } from '../multiagent/orchestration.js';
import { store } from '../store/memory.js';
import { addComment, getComments, resolveComment } from '../teams/comments.js';
import { loginUser, createUser, validateToken, authEnabled } from '../teams/auth.js';

const router = Router();

router.get('/graph', (_req: Request, res: Response) => {
  return res.json({ ok: true, graph: getAgentGraph() });
});

router.get('/sessions', async (_req: Request, res: Response) => {
  const sessions = await store.getAllSessions();
  const withCommentCounts = sessions.map(s => ({
    ...s,
    unresolved_comments: getComments(s.session_id).filter(c => !c.resolved).length,
  }));
  return res.json({ ok: true, sessions: withCommentCounts });
});

router.get('/sessions/:id', async (req: Request, res: Response) => {
  const session = await store.getSession(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
  return res.json({ ok: true, session });
});

router.get('/sessions/:id/events', async (req: Request, res: Response) => {
  const events = await store.getEvents(req.params.id);
  return res.json({ ok: true, events });
});

router.post('/sessions/:id/comments', (req: Request, res: Response) => {
  const { step_event_id, author, text } = req.body as { step_event_id: string; author: string; text: string };
  if (!step_event_id || !author || !text) {
    return res.status(400).json({ ok: false, error: 'Missing step_event_id, author, or text' });
  }
  const comment = addComment(req.params.id, step_event_id, author, text);
  return res.json({ ok: true, comment });
});

router.get('/sessions/:id/comments', (req: Request, res: Response) => {
  return res.json({ ok: true, comments: getComments(req.params.id) });
});

router.patch('/comments/:id/resolve', (req: Request, res: Response) => {
  const resolved = resolveComment(req.params.id);
  return res.json({ ok: resolved });
});

// Auth routes
router.post('/auth/login', (req: Request, res: Response) => {
  if (!authEnabled()) return res.json({ ok: true, token: 'auth-disabled' });
  const { username, password } = req.body as { username: string; password: string };
  const token = loginUser(username, password);
  if (!token) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  return res.json({ ok: true, token });
});

router.post('/auth/register', (req: Request, res: Response) => {
  if (!authEnabled()) return res.json({ ok: true, message: 'Auth disabled' });
  const { username, password, role } = req.body as { username: string; password: string; role?: 'viewer' | 'developer' | 'admin' };
  const user = createUser(username, password, role ?? 'developer');
  return res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

router.get('/auth/me', (req: Request, res: Response) => {
  if (!authEnabled()) return res.json({ ok: true, user: null });
  const token = req.headers['x-interveil-key'] as string;
  const user = validateToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'Invalid token' });
  return res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

export default router;
