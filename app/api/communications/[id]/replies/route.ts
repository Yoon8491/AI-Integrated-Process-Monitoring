import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth-server';
import { formatTimeSeoulWithSeconds, nowKstForDb } from '@/lib/date-format';

/** 댓글 목록 조회 (likes_count, dislikes_count, myVote 포함) */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const communicationId = parseInt(params.id);
    const authUser = await getAuthUser(request);

    let replies: any[];
    try {
      replies = await query(
        `SELECT id, communication_id, user, message, created_at,
                COALESCE(likes_count, 0) AS likes_count, COALESCE(dislikes_count, 0) AS dislikes_count
         FROM communication_replies
         WHERE communication_id = ?
         ORDER BY created_at ASC`,
        [communicationId]
      ) as any[];
    } catch {
      replies = await query(
        `SELECT id, communication_id, user, message, created_at
         FROM communication_replies
         WHERE communication_id = ?
         ORDER BY created_at ASC`,
        [communicationId]
      ) as any[];
      replies.forEach((r: any) => { r.likes_count = 0; r.dislikes_count = 0; });
    }

    let myVotes: Record<number, 'like' | 'dislike'> = {};
    if (authUser && replies.length > 0) {
      const userIdentifier = (authUser as any).id ?? (authUser as any).employeeNumber ?? (authUser as any).name ?? '';
      if (userIdentifier) {
        const ids = replies.map((r: any) => r.id).filter(Boolean);
        if (ids.length > 0) {
          const placeholders = ids.map(() => '?').join(',');
          const votes = await query(
            `SELECT reply_id, vote FROM communication_reply_votes WHERE user_identifier = ? AND reply_id IN (${placeholders})`,
            [String(userIdentifier), ...ids]
          ).catch(() => []) as any[];
          (votes || []).forEach((v: any) => { myVotes[v.reply_id] = v.vote; });
        }
      }
    }

    return NextResponse.json({
      success: true,
      replies: replies.map((reply: any) => ({
        id: reply.id,
        user: reply.user,
        message: reply.message,
        time: formatTimeSeoulWithSeconds(reply.created_at),
        created_at: reply.created_at,
        likes_count: Number(reply.likes_count) || 0,
        dislikes_count: Number(reply.dislikes_count) || 0,
        myVote: myVotes[reply.id] ?? null,
      })),
    });
  } catch (error: any) {
    console.error('댓글 조회 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '댓글을 불러올 수 없습니다.' },
      { status: 500 }
    );
  }
}

/** 댓글 작성 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) {
      return NextResponse.json(
        { success: false, error: '인증이 필요합니다.' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { user, message } = body;
    const communicationId = parseInt(params.id);

    if (!message || !user) {
      return NextResponse.json(
        { success: false, error: '댓글 내용과 작성자를 입력해주세요.' },
        { status: 400 }
      );
    }

    const result = await query(
      `INSERT INTO communication_replies (communication_id, user, message, created_at)
       VALUES (?, ?, ?, ?)`,
      [communicationId, user.trim(), message.trim(), nowKstForDb()]
    );

    return NextResponse.json({
      success: true,
      id: (result as any).insertId,
    });
  } catch (error: any) {
    console.error('댓글 작성 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '댓글 작성에 실패했습니다.' },
      { status: 500 }
    );
  }
}
