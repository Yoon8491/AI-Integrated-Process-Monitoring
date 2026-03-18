import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth-server';

/** 댓글 수정 */
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
    const { message } = body;
    const id = parseInt(params.id);

    if (!message) {
      return NextResponse.json(
        { success: false, error: '댓글 내용을 입력해주세요.' },
        { status: 400 }
      );
    }

    await query(
      `UPDATE communication_replies 
       SET message = ?
       WHERE id = ?`,
      [message.trim(), id]
    );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('댓글 수정 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '댓글 수정에 실패했습니다.' },
      { status: 500 }
    );
  }
}

/** 댓글 삭제 */
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

    await query('DELETE FROM communication_replies WHERE id = ?', [id]);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('댓글 삭제 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '댓글 삭제에 실패했습니다.' },
      { status: 500 }
    );
  }
}
