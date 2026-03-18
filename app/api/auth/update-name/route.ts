import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { cookies } from 'next/headers';

export async function POST(request: NextRequest) {
  try {
    const { name } = await request.json();

    if (!name || !name.trim()) {
      return NextResponse.json(
        { error: '이름을 입력해주세요.' },
        { status: 400 }
      );
    }

    // 쿠키에서 사용자 정보 가져오기
    const cookieStore = await cookies();
    const userCookie = cookieStore.get('user');

    if (!userCookie) {
      return NextResponse.json(
        { error: '로그인이 필요합니다.' },
        { status: 401 }
      );
    }

    let userData;
    try {
      userData = JSON.parse(userCookie.value);
    } catch (e) {
      return NextResponse.json(
        { error: '세션이 유효하지 않습니다.' },
        { status: 401 }
      );
    }

    const employeeNumber = userData.employeeNumber;
    const trimmedName = name.trim();

    // 길이 제한: 영어(공백 포함) 최대 10, 그 외 최대 5
    const isEnglish = /^[A-Za-z\s]+$/.test(trimmedName);
    const maxLen = isEnglish ? 10 : 5;
    if (trimmedName.length > maxLen) {
      return NextResponse.json(
        { error: '이름은 한글/기타 최대 5글자, 영어(공백 포함) 최대 10글자까지 가능합니다.' },
        { status: 400 }
      );
    }

    // 이름 업데이트
    try {
      await query(
        'UPDATE users SET name = ? WHERE employee_number = ?',
        [trimmedName, employeeNumber]
      );

      // 업데이트된 사용자 정보 가져오기
      const users = await query(
        'SELECT employee_number, name, role FROM users WHERE employee_number = ?',
        [employeeNumber]
      ) as any[];

      if (users.length === 0) {
        return NextResponse.json(
          { error: '사용자를 찾을 수 없습니다.' },
          { status: 404 }
        );
      }

      const updatedUser = users[0];
      const updatedUserData = {
        employeeNumber: updatedUser.employee_number,
        name: updatedUser.name,
        role: updatedUser.role,
      };

      // 쿠키 업데이트
      const response = NextResponse.json({
        success: true,
        user: updatedUserData,
      });

      response.cookies.set('user', JSON.stringify(updatedUserData), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7일
      });

      return response;
    } catch (dbError: any) {
      console.error('Database update error:', dbError);
      return NextResponse.json(
        { 
          error: process.env.NODE_ENV === 'development' 
            ? `데이터베이스 오류: ${dbError.message}`
            : '이름 변경 중 오류가 발생했습니다.'
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('Update name error:', error);
    return NextResponse.json(
      { 
        error: process.env.NODE_ENV === 'development' 
          ? `이름 변경 중 오류가 발생했습니다: ${error.message || error.toString()}`
          : '이름 변경 중 오류가 발생했습니다.'
      },
      { status: 500 }
    );
  }
}
