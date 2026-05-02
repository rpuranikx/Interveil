import { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'crypto';

export interface User {
  id: string;
  username: string;
  role: 'viewer' | 'developer' | 'admin';
  passwordHash: string;
  createdAt: string;
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

const users: Map<string, User> = new Map();
const sessions: Map<string, Session> = new Map();

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

export function createUser(username: string, password: string, role: User['role'] = 'developer'): User {
  const user: User = {
    id: randomBytes(8).toString('hex'),
    username,
    role,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  users.set(user.id, user);
  return user;
}

export function loginUser(username: string, password: string): string | null {
  const user = Array.from(users.values()).find(u => u.username === username);
  if (!user) return null;
  if (user.passwordHash !== hashPassword(password)) return null;

  const token = randomBytes(32).toString('hex');
  const session: Session = {
    token,
    userId: user.id,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24h
  };
  sessions.set(token, session);
  return token;
}

export function validateToken(token: string): User | null {
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return null;
  return users.get(session.userId) ?? null;
}

export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === 'true';
}

export function requireAuth(roles?: User['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!authEnabled()) return next();

    const token = req.headers['x-interveil-key'] as string | undefined
      ?? req.headers['authorization']?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const user = validateToken(token);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    }

    if (roles && !roles.includes(user.role)) {
      return res.status(403).json({ ok: false, error: `Requires role: ${roles.join(' or ')}` });
    }

    (req as Request & { user: User }).user = user;
    return next();
  };
}
