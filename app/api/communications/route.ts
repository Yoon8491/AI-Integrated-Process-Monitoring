import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth-server';
import { formatTimeSeoulWithSeconds, nowKstForDb } from '@/lib/date-format';

/** 커뮤니티 글 목록 조회 (댓글에 likes_count, dislikes_count, myVote 포함) */
export async function GET(request: NextRequest) {
  try {
    let communications: any[];
    try {
      // communications 테이블에서 조회 (likes_count, dislikes_count 포함, communication_replies와 동일하게)
      communications = await query(`
        SELECT c.id, c.user, c.message, c.content, c.created_at, c.updated_at,
               COALESCE(c.likes_count, 0) AS likes_count, COALESCE(c.dislikes_count, 0) AS dislikes_count,
               COUNT(cr.id) as reply_count
        FROM communications c
        LEFT JOIN communication_replies cr ON c.id = cr.communication_id
        GROUP BY c.id, c.user, c.message, c.content, c.created_at, c.updated_at, c.likes_count, c.dislikes_count
        ORDER BY c.created_at DESC
      `) as any[];
    } catch (e) {
      console.error('커뮤니티 글 조회 오류:', e);
      // 테이블이 없거나 조회 실패 시 빈 배열 반환
      return NextResponse.json({
        success: true,
        communications: [],
      });
    }
    
    if (!communications || communications.length === 0) {
      return NextResponse.json({
        success: true,
        communications: [],
      });
    }

    const authUser = await getAuthUser(request);
    let myCommVotes: Record<number, 'like' | 'dislike'> = {};
    let myReplyVotes: Record<number, 'like' | 'dislike'> = {};
    if (authUser) {
      const userIdentifier = (authUser as any).id ?? (authUser as any).employeeNumber ?? (authUser as any).name ?? '';
      if (userIdentifier) {
        try {
          // 커뮤니티 글 투표 조회
          const commIds = (communications as any[]).map((c: any) => c.id).filter(Boolean);
          if (commIds.length > 0) {
            try {
              const commPlaceholders = commIds.map(() => '?').join(',');
              const commVotes = await query(
                `SELECT communication_id, vote FROM communication_votes WHERE user_identifier = ? AND communication_id IN (${commPlaceholders})`,
                [String(userIdentifier), ...commIds]
              ).catch(() => []) as any[];
              (commVotes || []).forEach((v: any) => { myCommVotes[v.communication_id] = v.vote; });
            } catch (e) {
              console.error('커뮤니티 글 투표 조회 오류:', e);
              // 테이블이 없어도 계속 진행
            }
          }
        } catch (e) {
          console.error('커뮤니티 투표 조회 오류:', e);
        }
        try {
          // 댓글 투표 조회
          const allReplies = await query(
            `SELECT id FROM communication_replies`
          ).catch(() => []) as any[];
          const replyIds = (allReplies || []).map((r: any) => r.id).filter(Boolean);
          if (replyIds.length > 0) {
            try {
              const replyPlaceholders = replyIds.map(() => '?').join(',');
              const replyVotes = await query(
                `SELECT reply_id, vote FROM communication_reply_votes WHERE user_identifier = ? AND reply_id IN (${replyPlaceholders})`,
                [String(userIdentifier), ...replyIds]
              ).catch(() => []) as any[];
              (replyVotes || []).forEach((v: any) => { myReplyVotes[v.reply_id] = v.vote; });
            } catch (e) {
              console.error('댓글 투표 조회 오류:', e);
              // 테이블이 없어도 계속 진행
            }
          }
        } catch (e) {
          console.error('댓글 투표 조회 오류:', e);
        }
      }
    }

    const communicationsWithReplies = await Promise.all(
      (communications as any[]).map(async (comm: any) => {
        let replies: any[] = [];
        try {
          try {
            replies = await query(
              `SELECT id, communication_id, user, message, created_at,
                      COALESCE(likes_count, 0) AS likes_count, COALESCE(dislikes_count, 0) AS dislikes_count
               FROM communication_replies
               WHERE communication_id = ?
               ORDER BY created_at ASC`,
              [comm.id]
            ) as any[];
          } catch {
            replies = await query(
              `SELECT id, communication_id, user, message, created_at
               FROM communication_replies
               WHERE communication_id = ?
               ORDER BY created_at ASC`,
              [comm.id]
            ).catch(() => []) as any[];
            replies.forEach((r: any) => { r.likes_count = 0; r.dislikes_count = 0; });
          }
        } catch (e) {
          console.error(`댓글 조회 오류 (communication_id: ${comm.id}):`, e);
          replies = [];
        }

        return {
          id: comm.id,
          user: comm.user,
          message: comm.message,
          content: comm.content,
          time: formatTimeSeoulWithSeconds(comm.created_at),
          created_at: comm.created_at,
          updated_at: comm.updated_at,
          likes_count: Number(comm.likes_count) || 0,
          dislikes_count: Number(comm.dislikes_count) || 0,
          myVote: myCommVotes[comm.id] ?? null,
          replies: replies.map((reply: any) => ({
            id: reply.id,
            user: reply.user,
            message: reply.message,
            time: formatTimeSeoulWithSeconds(reply.created_at),
            created_at: reply.created_at,
            likes_count: Number(reply.likes_count) || 0,
            dislikes_count: Number(reply.dislikes_count) || 0,
            myVote: myReplyVotes[reply.id] ?? null,
          })),
        };
      })
    ).catch((e) => {
      console.error('커뮤니티 데이터 처리 오류:', e);
      // 에러 발생 시 빈 배열 반환
      return [];
    });

    console.log(`커뮤니티 조회 완료: ${communicationsWithReplies.length}개 글`);
    
    return NextResponse.json({
      success: true,
      communications: communicationsWithReplies,
    });
  } catch (error: any) {
    console.error('커뮤니티 조회 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '커뮤니티 글을 불러올 수 없습니다.' },
      { status: 500 }
    );
  }
}

/** 커뮤니티 글 작성 */
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) {
      return NextResponse.json(
        { success: false, error: '인증이 필요합니다.' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { user, message, content } = body;

    if (!message || !content || !user) {
      return NextResponse.json(
        { success: false, error: '제목, 내용, 작성자를 입력해주세요.' },
        { status: 400 }
      );
    }

    const nowKst = nowKstForDb();
    const result = await query(
      `INSERT INTO communications (user, message, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [user.trim(), message.trim(), content.trim(), nowKst, nowKst]
    );

    return NextResponse.json({
      success: true,
      id: (result as any).insertId,
    });
  } catch (error: any) {
    console.error('커뮤니티 글 작성 오류:', error);
    return NextResponse.json(
      { success: false, error: error.message || '커뮤니티 글 작성에 실패했습니다.' },
      { status: 500 }
    );
  }
}
