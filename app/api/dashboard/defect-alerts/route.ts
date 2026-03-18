import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 불량 레포트(lot_defect_reports) 최근 목록 - lot-status와 동일 DB(lib/db)에서 직접 조회 (백엔드 없이 알람 내역 표시) */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const limit = Math.min(Number(searchParams.get('limit')) || 50, 100);
    const since = (searchParams.get('since') || '').trim();

    const rows = (await (since
      ? query(
          `SELECT lot_id, DATE_FORMAT(lot_defect_reports.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp
           FROM lot_defect_reports
           WHERE lot_defect_reports.timestamp > ? ORDER BY lot_defect_reports.timestamp DESC LIMIT ?`,
          [since, limit]
        )
      : query(
          `SELECT lot_id, DATE_FORMAT(lot_defect_reports.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp
           FROM lot_defect_reports
           ORDER BY lot_defect_reports.timestamp DESC LIMIT ?`,
          [limit]
        ))) as { lot_id: string; timestamp: string }[];

    const alerts = (rows || []).map((r) => {
      const tsStr = String(r.timestamp ?? '');
      return {
        id: `defect_${r.lot_id}_${tsStr}`,
        type: 'defect',
        lot_id: r.lot_id,
        timestamp: tsStr,
      };
    });

    return NextResponse.json({ success: true, alerts });
  } catch (e) {
    // 테이블 없음 등 DB 오류 시 빈 목록 반환
    console.warn('[defect-alerts] DB read failed (table may not exist):', e instanceof Error ? e.message : e);
    return NextResponse.json({ success: true, alerts: [] });
  }
}
