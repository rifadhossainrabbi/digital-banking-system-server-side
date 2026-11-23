import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { getDB } from '../lib/db';

export interface JwtPayload {
  userId: string;
  email: string;
  role: 'Admin' | 'Bank Staff' | 'Customer';
  iat?: number;
  exp?: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtPayload;
  }
}

/** Verify JWT from Bearer token */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized: missing token.' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET not configured');

    const payload = jwt.verify(token, secret) as JwtPayload;

    // Confirm user still exists and is active
    const db = await getDB();
    const user = await db
      .collection('users')
      .findOne({ email: payload.email.toLowerCase() });

    if (!user) {
      res.status(401).json({ error: 'Unauthorized: user not found.' });
      return;
    }
    if (user.status !== 'Active') {
      res.status(403).json({ error: 'Account is suspended or inactive.' });
      return;
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized: invalid or expired token.' });
  }
}

/** Role-based authorization factory */
export function authorize(...roles: JwtPayload['role'][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden: insufficient permissions.' });
      return;
    }
    next();
  };
}
