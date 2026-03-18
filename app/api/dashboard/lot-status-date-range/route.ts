import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** LOT별 공정현황 달력: lot_defect_reports 기준. 과거~오늘 넓은 범위로 조회 가능 */
export async function GET() {
  try {
    const rows: any = await query(
      `SELECT MIN(DATE(timestamp)) as min_date, MAX(DATE(timestamp)) as max_date
       FROM lot_defect_reports
       WHERE timestamp IS NOT NULL`
    );

    const dbMin = rows?.[0]?.min_date ? String(rows[0].min_date).slice(0, 10) : null;
    const dbMax = rows?.[0]?.max_date ? String(rows[0].max_date).slice(0, 10) : null;
    const today = new Date().toISOString().slice(0, 10);
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const fallbackMin = twoYearsAgo.toISOString().slice(0, 10);

    // lot_defect_reports 범위와 관계없이 과거 날짜 조회 가능하도록 넓은 범위 사용
    const minDate = dbMin && dbMin < fallbackMin ? dbMin : fallbackMin;
    const maxDate = (dbMax && dbMax > today ? dbMax : today);

    return NextResponse.json({
      success: true,
      minDate,
      maxDate,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Lot status date range API error:', msg);
    const today = new Date().toISOString().slice(0, 10);
    return NextResponse.json(
      { success: false, error: msg, minDate: today, maxDate: today },
      { status: 500 }
    );
  }
}
