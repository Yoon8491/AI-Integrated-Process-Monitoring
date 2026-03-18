import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth-server';
import { nowKstForDb } from '@/lib/date-format';

/** 커뮤니티 글 좋아요/싫어요 (한 사용자 한 번만 반영, 중복 방지). communications 사용. */
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

    const body = await request.json().catch(() => ({}));
    const action = body?.action === 'dislike' ? 'dislike' : 'like';
    const commId = parseInt(params.id, 10);
    if (!Number.isFinite(commId)) {
      return NextResponse.json(
        { success: false, error: '잘못된 글 ID입니다.' },
        { status: 400 }
      );
    }

    const userIdentifier = (authUser as any).id ?? (authUser as any).employeeNumber ?? (authUser as any).name ?? '';
    if (!userIdentifier) {
      return NextResponse.json(
        { success: false, error: '사용자 식별 정보가 없습니다.' },
        { status: 400 }
      );
    }

    // communication_votes 테이블 생성 (communication_reply_votes와 동일한 구조)
    await query(`
      CREATE TABLE IF NOT EXISTS communication_votes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        communication_id INT NOT NULL,
        user_identifier VARCHAR(128) NOT NULL,
        vote ENUM('like','dislike') NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uq_comm_user (communication_id, user_identifier),
        KEY idx_comm (communication_id)
      )
    `).catch(() => {});

    const now = nowKstForDb();

    // 글 존재 확인
    const rows = await query(
      `SELECT id FROM communications WHERE id = ?`,
      [commId]
    ) as any[];
    if (!rows?.length) {
      return NextResponse.json(
        { success: false, error: '글을 찾을 수 없습니다.' },
        { status: 404 }
      );
    }

    // 기존 투표 확인
    const existing = await query(
      `SELECT vote FROM communication_votes WHERE communication_id = ? AND user_identifier = ?`,
      [commId, String(userIdentifier)]
    ) as any[];

    if (existing?.length > 0) {
      const prev = existing[0].vote;
      if (prev === action) {
        // 같은 액션을 다시 누르면 취소 (투표 삭제)
        await query(
          `DELETE FROM communication_votes WHERE communication_id = ? AND user_identifier = ?`,
          [commId, String(userIdentifier)]
        );
      } else {
        // 다른 액션으로 변경
        await query(
          `UPDATE communication_votes SET vote = ?, created_at = ? WHERE communication_id = ? AND user_identifier = ?`,
          [action, now, commId, String(userIdentifier)]
        );
      }
    } else {
      // 새로 투표
      await query(
        `INSERT INTO communication_votes (communication_id, user_identifier, vote, created_at) VALUES (?, ?, ?, ?)`,
        [commId, String(userIdentifier), action, now]
      );
    }

    // 투표 테이블에서 실제 카운트 계산
    const likesResult = await query(
      `SELECT COUNT(*) AS count FROM communication_votes WHERE communication_id = ? AND vote = 'like'`,
      [commId]
    ) as any[];
    const dislikesResult = await query(
      `SELECT COUNT(*) AS count FROM communication_votes WHERE communication_id = ? AND vote = 'dislike'`,
      [commId]
    ) as any[];

    const likesCount = Number(likesResult[0]?.count) || 0;
    const dislikesCount = Number(dislikesResult[0]?.count) || 0;

    // 현재 사용자의 투표 상태 확인
    const currentVote = await query(
      `SELECT vote FROM communication_votes WHERE communication_id = ? AND user_identifier = ?`,
      [commId, String(userIdentifier)]
    ) as any[];

    const myVote = currentVote?.length > 0 ? currentVote[0].vote : null;

    // communications 테이블에 카운트 반영 (communication_replies와 동일하게)
    await query(
      `UPDATE communications SET likes_count = ?, dislikes_count = ? WHERE id = ?`,
      [likesCount, dislikesCount, commId]
    );

    return NextResponse.json({
      success: true,
      likes_count: likesCount,
      dislikes_count: dislikesCount,
      myVote: myVote,
    });
  } catch (error: any) {
    console.error('커뮤니티 글 투표 오류:', { message: error?.message, code: error?.code, stack: error?.stack });
    const isConnectionError =
      error?.code === 'ECONNREFUSED' ||
      error?.code === 'ETIMEDOUT' ||
      error?.code === 'ENOTFOUND' ||
      /connect|connection|연동|연결/i.test(String(error?.message || ''));
    return NextResponse.json(
      {
        success: false,
        error: isConnectionError ? '연결 실패' : (error?.message || '투표에 실패했습니다.'),
      },
      { status: 500 }
    );
  }
}
