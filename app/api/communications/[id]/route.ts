import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth-server';
import { nowKstForDb } from '@/lib/date-format';

/** 커뮤니티 글 수정 */
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
    const { message, content } = body;
    const id = parseInt(params.id);

    if (!message || !content) {
      return NextResponse.json(
        { success: false, error: '제목과 내용을 입력해주세요.' },
        { status: 400 }
      );
    }

    await query(
      `UPDATE communications 
       SET message = ?, content = ?, updated_at = ?
       WHERE id = ?`,
      [message.trim(), content.trim(), nowKstForDb(), id]
    );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('커뮤니티 글 수정 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '커뮤니티 글 수정에 실패했습니다.' },
      { status: 500 }
    );
  }
}

/** 커뮤니티 글 삭제 */
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

    // 댓글도 함께 삭제
    await query('DELETE FROM communication_replies WHERE communication_id = ?', [id]);
    await query('DELETE FROM communications WHERE id = ?', [id]);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('커뮤니티 글 삭제 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '커뮤니티 글 삭제에 실패했습니다.' },
      { status: 500 }
    );
  }
}
