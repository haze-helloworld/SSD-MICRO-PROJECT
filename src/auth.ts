import jwt from 'jsonwebtoken';
import { NAME_RE, USER_RE } from './types.js';

export interface Claims {
  user: string;
  tenant: string;
  rooms: string[] | null; // null = any room inside the tenant
}

export function signToken(
  secret: string,
  c: { user: string; tenant: string; rooms?: string[] },
  ttlSec = 3600,
): string {
  return jwt.sign({ sub: c.user, tid: c.tenant, rooms: c.rooms }, secret, { algorithm: 'HS256', expiresIn: ttlSec });
}

/** Returns validated claims or null. Never throws. */
export function verifyToken(token: string | null | undefined, secret: string): Claims | null {
  if (!token) return null;
  try {
    const p = jwt.verify(token, secret, { algorithms: ['HS256'] }) as Record<string, unknown>;
    const user = String(p.sub ?? '');
    const tenant = String(p.tid ?? '');
    if (!USER_RE.test(user) || !NAME_RE.test(tenant)) return null;
    let rooms: string[] | null = null;
    if (Array.isArray(p.rooms)) {
      rooms = p.rooms.map(String);
      if (!rooms.every((r) => r === '*' || NAME_RE.test(r))) return null;
    }
    return { user, tenant, rooms };
  } catch {
    return null;
  }
}
