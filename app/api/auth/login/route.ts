import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import bcrypt from 'bcryptjs';
import { signToken, AUTH_COOKIE } from '@/lib/jwt';

export async function POST(request: NextRequest) {
  try {
    // 배포 환경에서 JWT 설정 누락 시 안내
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd && !process.env.JWT_SECRET) {
      console.error('Login: JWT_SECRET not set');
      return NextResponse.json(
        { error: '서버 설정이 완료되지 않았습니다. 관리자에게 문의하세요.' },
        { status: 503 }
      );
    }

    const { employeeNumber, password } = await request.json();

    if (!employeeNumber || !password) {
      return NextResponse.json(
        { error: '사원번호와 비밀번호를 입력해주세요.' },
        { status: 400 }
      );
    }

    // users 테이블에서 사원번호로 사용자 조회
    let users: any[];
    try {
      users = await query(
        'SELECT * FROM users WHERE employee_number = ?',
        [employeeNumber]
      ) as any[];
    } catch (dbError: any) {
      console.error('Database query error:', dbError);
      const msg =
        process.env.NODE_ENV === 'development'
          ? `데이터베이스 연결 오류: ${dbError.message}`
          : '데이터베이스 연결에 실패했습니다. 관리자에게 문의하세요.';
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    if (users.length === 0) {
      return NextResponse.json(
        { error: '사원번호 또는 비밀번호가 올바르지 않습니다.' },
        { status: 401 }
      );
    }

    const user = users[0];
    if (!user || user.password == null || user.password === undefined) {
      console.error('Login: user password missing for', employeeNumber);
      return NextResponse.json(
        { error: isProd ? '계정 데이터 오류입니다. 관리자에게 문의하세요.' : 'user.password missing' },
        { status: 500 }
      );
    }

    const isPasswordValid = await bcrypt.compare(password, String(user.password));
    if (!isPasswordValid) {
      return NextResponse.json(
        { error: '사원번호 또는 비밀번호가 올바르지 않습니다.' },
        { status: 401 }
      );
    }

    const userData = {
      employeeNumber: user.employee_number,
      name: user.name,
      role: user.role,
    };

    let token: string;
    try {
      token = await signToken(userData);
    } catch (signError: any) {
      console.error('Login: signToken error', signError);
      return NextResponse.json(
        { error: isProd ? '서버 설정 오류입니다. 관리자에게 문의하세요.' : String(signError?.message || signError) },
        { status: 503 }
      );
    }

    const response = NextResponse.json({ success: true, user: userData, token });
    response.cookies.set(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });
    return response;
  } catch (error: any) {
    console.error('Login error:', error);
    const isProd = process.env.NODE_ENV === 'production';
    const errorMessage =
      process.env.NODE_ENV === 'development'
        ? `로그인 중 오류가 발생했습니다: ${error.message || error.toString()}`
        : '로그인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
