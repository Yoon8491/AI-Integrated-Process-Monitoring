import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import bcrypt from 'bcryptjs';

export async function POST(request: NextRequest) {
  try {
    const { employeeNumber, password } = await request.json();

    if (!employeeNumber || !employeeNumber.trim()) {
      return NextResponse.json(
        { error: '사원번호를 입력해주세요.' },
        { status: 400 }
      );
    }

    if (!password) {
      return NextResponse.json(
        { error: '비밀번호를 입력해주세요.' },
        { status: 400 }
      );
    }

    if (password.length < 4) {
      return NextResponse.json(
        { error: '비밀번호는 최소 4자 이상이어야 합니다.' },
        { status: 400 }
      );
    }

    const trimmedEmployeeNumber = employeeNumber.trim();

    // 사원번호 중복 확인
    try {
      const existingUsers = await query(
        'SELECT * FROM users WHERE employee_number = ?',
        [trimmedEmployeeNumber]
      ) as any[];

      if (existingUsers.length > 0) {
        return NextResponse.json(
          { error: '이미 사용 중인 사원번호입니다.' },
          { status: 409 }
        );
      }
    } catch (dbError: any) {
      console.error('Database query error during signup:', dbError);
      return NextResponse.json(
        { 
          error: process.env.NODE_ENV === 'development' 
            ? `데이터베이스 연결 오류: ${dbError.message}`
            : '데이터베이스 연결에 실패했습니다. 관리자에게 문의하세요.'
        },
        { status: 500 }
      );
    }

    // 비밀번호 해시
    const hashedPassword = await bcrypt.hash(password, 10);

    // 기본 이름 설정
    const userName = '사용자';

    // 사용자 생성
    try {
      await query(
        'INSERT INTO users (employee_number, name, password, role) VALUES (?, ?, ?, ?)',
        [trimmedEmployeeNumber, userName, hashedPassword, 'user']
      );

      return NextResponse.json({
        success: true,
        message: '회원가입이 완료되었습니다.',
        employeeNumber: trimmedEmployeeNumber,
        name: userName,
      });
    } catch (dbError: any) {
      console.error('Database insert error during signup:', dbError);
      
      // 중복 키 에러 처리
      if (dbError.code === 'ER_DUP_ENTRY') {
        return NextResponse.json(
          { error: '이미 존재하는 사원번호입니다. 다시 시도해주세요.' },
          { status: 409 }
        );
      }

      return NextResponse.json(
        { 
          error: process.env.NODE_ENV === 'development' 
            ? `데이터베이스 오류: ${dbError.message}`
            : '회원가입 중 오류가 발생했습니다. 관리자에게 문의하세요.'
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('Signup error:', error);
    return NextResponse.json(
      { 
        error: process.env.NODE_ENV === 'development' 
          ? `회원가입 중 오류가 발생했습니다: ${error.message || error.toString()}`
          : '회원가입 중 오류가 발생했습니다.'
      },
      { status: 500 }
    );
  }
}
