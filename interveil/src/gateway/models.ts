import { Router, Request, Response } from 'express';

const router: Router = Router();

const STATIC_MODELS = [
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo',
  'o1', 'o1-mini', 'o3', 'o3-mini',
  'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-haiku-4-20250514',
  'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
  'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash',
];

router.get('/', (_req: Request, res: Response) => {
  const models = STATIC_MODELS.map((id) => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: id.startsWith('claude-') ? 'anthropic' : id.startsWith('gemini-') ? 'google' : 'openai',
  }));

  res.json({ object: 'list', data: models });
});

router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

export default router;
