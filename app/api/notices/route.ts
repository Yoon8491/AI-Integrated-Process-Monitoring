import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth-server';
import { formatDateSeoul, nowKstForDb } from '@/lib/date-format';

/** 공지사항 목록 조회 */
export async function GET(request: NextRequest) {
  try {
    const notices = await query(`
      SELECT id, title, content, important, author, created_at, updated_at
      FROM notices
      ORDER BY important DESC, created_at DESC
    `);

    return NextResponse.json({
      success: true,
      notices: notices.map((notice: any) => ({
        id: notice.id,
        title: notice.title,
        content: notice.content,
        important: Boolean(notice.important),
        author: notice.author || '시스템 관리팀',
        date: formatDateSeoul(notice.created_at),
        created_at: notice.created_at,
        updated_at: notice.updated_at,
      })),
    });
  } catch (error: any) {
    console.error('공지사항 조회 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '공지사항을 불러올 수 없습니다.' },
      { status: 500 }
    );
  }
}

/** 공지사항 작성 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: '인증이 필요합니다.' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { title, content, important, author } = body;

    if (!title || !content) {
      return NextResponse.json(
        { success: false, error: '제목과 내용을 입력해주세요.' },
        { status: 400 }
      );
    }

    const nowUtc = nowKstForDb();
    const result = await query(
      `INSERT INTO notices (title, content, important, author, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [title.trim(), content.trim(), important ? 1 : 0, author || '시스템 관리팀', nowUtc, nowUtc]
    );

    return NextResponse.json({
      success: true,
      id: (result as any).insertId,
    });
  } catch (error: any) {
    console.error('공지사항 작성 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '공지사항 작성에 실패했습니다.' },
      { status: 500 }
    );
  }
}
