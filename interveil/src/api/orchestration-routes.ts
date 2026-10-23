import { Router, Request, Response } from 'express';
import { getAgentGraph } from '../multiagent/orchestration.js';
import { store } from '../store/memory.js';
import { addComment, getComments, resolveComment } from '../teams/comments.js';
import { getRecentRequests } from '../gateway/llm-proxy.js';

const router: Router = Router();

router.get('/graph', (_req: Request, res: Response) => {
  return res.json({ ok: true, graph: getAgentGraph() });
});

router.get('/gateway/stats', (_req: Request, res: Response) => {
  const requests = getRecentRequests();
  const totalTokens = requests.reduce((sum, r) => sum + r.tokens, 0);
  const avgLatency = requests.length
    ? Math.round(requests.reduce((sum, r) => sum + r.latency, 0) / requests.length)
    : 0;
  return res.json({ ok: true, recent_requests: requests, total_tokens: totalTokens, avg_latency_ms: avgLatency });
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

export default router;
