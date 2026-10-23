import { Router, Request, Response } from 'express';
import { getRecentRequests } from '../gateway/llm-proxy.js';

/** GET /api/v1/gateway/stats — the dashboard's Gateway tab: the last ten proxied requests. */
const router: Router = Router();

router.get('/stats', (_req: Request, res: Response) => {
  const requests = getRecentRequests();
  const totalTokens = requests.reduce((sum, r) => sum + r.tokens, 0);
  const avgLatency = requests.length
    ? Math.round(requests.reduce((sum, r) => sum + r.latency, 0) / requests.length)
    : 0;
  return res.json({ ok: true, recent_requests: requests, total_tokens: totalTokens, avg_latency_ms: avgLatency });
});

export default router;
