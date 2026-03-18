import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth-server';

/** 공지사항 수정 */
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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
    const id = parseInt(params.id);

    if (!title || !content) {
      return NextResponse.json(
        { success: false, error: '제목과 내용을 입력해주세요.' },
        { status: 400 }
      );
    }

    await query(
      `UPDATE notices 
       SET title = ?, content = ?, important = ?, author = ?, updated_at = NOW()
       WHERE id = ?`,
      [title.trim(), content.trim(), important ? 1 : 0, author || '시스템 관리팀', id]
    );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('공지사항 수정 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '공지사항 수정에 실패했습니다.' },
      { status: 500 }
    );
  }
}

/** 공지사항 삭제 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getAuthUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: '인증이 필요합니다.' },
        { status: 401 }
      );
    }

    const id = parseInt(params.id);

    await query('DELETE FROM notices WHERE id = ?', [id]);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('공지사항 삭제 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '공지사항 삭제에 실패했습니다.' },
      { status: 500 }
    );
  }
}
