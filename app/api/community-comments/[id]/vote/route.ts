import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth-server';
import { nowKstForDb } from '@/lib/date-format';

/**
 * POST /api/community-comments/[id]/vote
 * Body: { action: 'like' | 'dislike' }
 * 좋아요/싫어요 투표. 같은 액션을 다시 누르면 취소됩니다.
 * Returns updated counts, myVote, and created_at.
 */
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

    const commentId = parseInt(params.id, 10);
    if (!Number.isFinite(commentId)) {
      return NextResponse.json(
        { success: false, error: '잘못된 댓글 ID입니다.' },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const action = body?.action === 'dislike' ? 'dislike' : 'like';
    const userIdentifier = (authUser as any).id ?? (authUser as any).employeeNumber ?? (authUser as any).name ?? '';
    if (!userIdentifier) {
      return NextResponse.json(
        { success: false, error: '사용자 식별 정보가 없습니다.' },
        { status: 400 }
      );
    }

    // 투표 추적 테이블 생성
    await query(`
      CREATE TABLE IF NOT EXISTS community_comment_votes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        comment_id INT NOT NULL,
        user_identifier VARCHAR(128) NOT NULL,
        vote ENUM('like','dislike') NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uq_comment_user (comment_id, user_identifier),
        KEY idx_comment (comment_id)
      )
    `).catch(() => {});

    const now = nowKstForDb();

    // 현재 카운트 조회
    const rows = await query(
      `SELECT id, COALESCE(likes_count, 0) AS likes_count, COALESCE(dislikes_count, 0) AS dislikes_count, created_at
       FROM community_comments WHERE id = ?`,
      [commentId]
    ) as any[];
    if (!rows?.length) {
      return NextResponse.json(
        { success: false, error: '댓글을 찾을 수 없습니다.' },
        { status: 404 }
      );
    }

    let likesCount = Number(rows[0].likes_count) || 0;
    let dislikesCount = Number(rows[0].dislikes_count) || 0;

    // 기존 투표 확인
    const existing = await query(
      `SELECT vote FROM community_comment_votes WHERE comment_id = ? AND user_identifier = ?`,
      [commentId, String(userIdentifier)]
    ) as any[];

    let myVote: 'like' | 'dislike' | null = null;

    if (existing?.length > 0) {
      const prev = existing[0].vote;
      if (prev === action) {
        // 같은 액션을 다시 누르면 취소 (투표 삭제)
        await query(
          `DELETE FROM community_comment_votes WHERE comment_id = ? AND user_identifier = ?`,
          [commentId, String(userIdentifier)]
        );
        if (action === 'like') {
          likesCount = Math.max(0, likesCount - 1);
        } else {
          dislikesCount = Math.max(0, dislikesCount - 1);
        }
        myVote = null;
      } else {
        // 다른 액션으로 변경
        await query(
          `UPDATE community_comment_votes SET vote = ?, created_at = ? WHERE comment_id = ? AND user_identifier = ?`,
          [action, now, commentId, String(userIdentifier)]
        );
        if (prev === 'like') {
          likesCount = Math.max(0, likesCount - 1);
          dislikesCount += 1;
        } else {
          dislikesCount = Math.max(0, dislikesCount - 1);
          likesCount += 1;
        }
        myVote = action;
      }
    } else {
      // 새로 투표
      await query(
        `INSERT INTO community_comment_votes (comment_id, user_identifier, vote, created_at) VALUES (?, ?, ?, ?)`,
        [commentId, String(userIdentifier), action, now]
      );
      if (action === 'like') likesCount += 1;
      else dislikesCount += 1;
      myVote = action;
    }

    // 카운트 업데이트
    await query(
      `UPDATE community_comments SET likes_count = ?, dislikes_count = ? WHERE id = ?`,
      [likesCount, dislikesCount, commentId]
    );

    return NextResponse.json({
      success: true,
      likes_count: likesCount,
      dislikes_count: dislikesCount,
      myVote: myVote,
      created_at: rows[0].created_at,
    });
  } catch (error: any) {
    console.error('community-comments vote error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || '좋아요/싫어요 반영에 실패했습니다.',
      },
      { status: 500 }
    );
  }
}
