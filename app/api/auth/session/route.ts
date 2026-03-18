import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyToken, AUTH_COOKIE } from '@/lib/jwt';

export async function GET(request: NextRequest) {
  try {
    let token: string | undefined;

    const cookieStore = await cookies();
    token = cookieStore.get(AUTH_COOKIE)?.value;

    if (!token) {
      const authHeader = request.headers.get('authorization');
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
      }
    }

    if (!token) {
      return NextResponse.json({ user: null });
    }

    const user = await verifyToken(token);
    if (!user) {
      const res = NextResponse.json({ user: null });
      res.cookies.delete(AUTH_COOKIE);
      return res;
    }

    return NextResponse.json({ user });
  } catch {
    return NextResponse.json({ user: null });
  }
}
