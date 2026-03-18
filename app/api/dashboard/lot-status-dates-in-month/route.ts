import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** LOT별 공정현황 달력: 해당 월에 lot_defect_reports에 데이터가 있는 날짜(YYYY-MM-DD) 목록. 선택 가능한 날만 표시 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const year = searchParams.get('year') ? parseInt(searchParams.get('year')!, 10) : new Date().getFullYear();
  const month = searchParams.get('month') ? parseInt(searchParams.get('month')!, 10) : new Date().getMonth() + 1;

  try {
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = new Date(year, month, 0);
    const monthEndStr = `${year}-${String(month).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`;

    const rows: any = await query(
      `SELECT DISTINCT DATE(timestamp) as d
       FROM lot_defect_reports
       WHERE timestamp >= ? AND timestamp <= ?
       ORDER BY d`,
      [monthStart, monthEndStr]
    );

    const dates = (rows || []).map((r: { d: string }) => {
      const s = r.d ? String(r.d) : '';
      return s.slice(0, 10);
    }).filter(Boolean);

    return NextResponse.json({ success: true, dates });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Lot status dates-in-month API error:', msg);
    return NextResponse.json({ success: false, error: msg, dates: [] }, { status: 500 });
  }
}
