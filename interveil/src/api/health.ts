import { Router, Request, Response } from 'express';

const router: Router = Router();
const VERSION = '0.1.0';

router.get('/', (_req: Request, res: Response) => {
  return res.json({ ok: true, version: VERSION });
});

export default router;
