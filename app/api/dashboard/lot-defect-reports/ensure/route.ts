import { NextRequest, NextResponse } from 'next/server';
import { getReportFromDb, ensureLotReportsTable } from '@/lib/lot-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST: 불량 LOT 목록에 대해 레포트가 없으면 생성 요청 (클라이언트가 내부적으로 /lot-defect-report POST 호출)
 * 이 API는 어떤 LOT에 레포트가 없는지 반환. 실제 생성은 클라이언트에서 처리하거나
 * 서버에서 바로 생성할 수 있음.
 * 
 * body: { lots: LotStatus[] }
 * 반환: { missing: string[] } - 레포트가 없는 lotId 목록
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { lots } = body;

    if (!Array.isArray(lots) || lots.length === 0) {
      return NextResponse.json({ success: true, missing: [], generating: [] });
    }

    await ensureLotReportsTable();

    const missing: string[] = [];
    for (const lot of lots) {
      const lotId = lot?.lotId ?? lot?.lot_id;
      if (!lotId) continue;
      // 불량 LOT만
      const isDefect = lot.passFailResult === '불합격' || lot.passFailResult === 'Fail' || lot.latest_result === '1';
      if (!isDefect) continue;

      const existing = await getReportFromDb(String(lotId));
      if (!existing) {
        missing.push(String(lotId));
      }
    }

    return NextResponse.json({ success: true, missing });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[lot-defect-reports/ensure] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
