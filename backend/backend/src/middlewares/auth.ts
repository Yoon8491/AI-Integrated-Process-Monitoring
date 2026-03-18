import type { FastifyRequest } from 'fastify';
import { verifyToken, type JwtPayload } from '../jwt.js';

export type AuthenticatedRequest = FastifyRequest & { user?: JwtPayload };

export async function requireAuth(request: AuthenticatedRequest) {
  const header = request.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  
  // 디버깅 로그
  console.log('[requireAuth]', {
    hasHeader: !!header,
    scheme,
    hasToken: !!token,
    headerPreview: header ? `${header.substring(0, 30)}...` : null
  });
  
  if (scheme !== 'Bearer' || !token) {
    console.log('[requireAuth] Invalid scheme or missing token');
    return null;
  }
  
  const user = await verifyToken(token);
  if (!user) {
    console.log('[requireAuth] Token verification failed');
    return null;
  }
  
  console.log('[requireAuth] Success:', { employeeNumber: user.employeeNumber });
  request.user = user;
  return user;
}

