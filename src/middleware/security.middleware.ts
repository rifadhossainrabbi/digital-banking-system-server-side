import { Request, Response, NextFunction } from 'express';

/**
 * Sanitizes incoming request bodies & query parameters against NoSQL injection
 * by stripping or neutralizing malicious MongoDB operator keys ($gt, $ne, $where, etc.).
 */
export function sanitizeInputs(req: Request, _res: Response, next: NextFunction): void {
  const sanitize = (obj: any): any => {
    if (!obj || typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map(sanitize);
    }

    const cleaned: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
      // Reject or strip dollar-prefixed NoSQL operators from client payloads
      if (key.startsWith('$')) {
        continue;
      }
      cleaned[key] = sanitize(obj[key]);
    }
    return cleaned;
  };

  if (req.body) {
    req.body = sanitize(req.body);
  }
  if (req.query) {
    req.query = sanitize(req.query);
  }

  next();
}

/**
 * Attaches banking security headers to all outbound responses.
 */
export function attachBankingSecurityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}
