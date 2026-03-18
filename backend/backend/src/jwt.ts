import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';

export type JwtPayload = {
  employeeNumber: string;
  name: string;
  role: 'admin' | 'user';
};

const getSecret = () => new TextEncoder().encode(config.jwtSecret);

export async function signToken(
  payload: JwtPayload,
  expiresIn: string = '7d'
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(getSecret());
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return {
      employeeNumber: payload.employeeNumber as string,
      name: payload.name as string,
      role: payload.role as 'admin' | 'user',
    };
  } catch (error) {
    console.error('[verifyToken] Token verification failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

