import { NextResponse } from 'next/server';
import {
  getConnection,
  getProcessDataTable,
  getProcessColumnMap,
} from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAY_LABELS_KO = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const period = (url.searchParams.get('period') || 'week') as 'day' | 'week' | 'month';
  let conn;
  try {
    conn = await getConnection();
    const processTable = await getProcessDataTable(conn);
    if (!processTable) {
      conn.release();
      conn = null;
      return NextResponse.json({ success: true, period, data: [], byLine: [] });
    }

    const map = await getProcessColumnMap(conn, processTable);
    const { table, dateCol, passRateCol, defectCol, lineCol } = map;
    if (!dateCol) {
      conn.release();
      conn = null;
      return NextResponse.json({ success: true, period, data: [], byLine: [] });
    }

    type QualityRow = { day?: string; dayLabel?: string; week?: string; time?: string; passRate: number; defectRate: number; inspected?: number };
    let data: QualityRow[] = [];
    const prCol = passRateCol || defectCol;
    const prSel = prCol ? `AVG(\`${prCol}\`) as pr` : '98 as pr';
    const drSel = defectCol ? `AVG(\`${defectCol}\`) as dr` : '2 as dr';

    if (period === 'day') {
      const [rows] = await conn.query<any[]>(
        `SELECT HOUR(\`${dateCol}\`) as h, ${prSel}, ${drSel}
         FROM \`${table}\` WHERE DATE(\`${dateCol}\`) = CURDATE()
         GROUP BY HOUR(\`${dateCol}\`) ORDER BY h`
      );
      data = (rows || []).map((r) => ({
        time: `${String(r.h).padStart(2, '0')}:00`,
        passRate: Number(r.pr ?? 98),
        defectRate: Number(r.dr ?? 2),
      }));
    } else if (period === 'week') {
      const [rows] = await conn.query<any[]>(
        `SELECT DAYOFWEEK(\`${dateCol}\`) as dow, ${prSel}, ${drSel}
         FROM \`${table}\` WHERE \`${dateCol}\` >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
         GROUP BY DATE(\`${dateCol}\`) ORDER BY DATE(\`${dateCol}\`)`
      );
      const byDay: Record<number, { passRate: number; defectRate: number }> = {};
      (rows || []).forEach((r) => {
        const dow = Number(r.dow ?? 1);
        byDay[dow] = { passRate: Number(r.pr ?? 98), defectRate: Number(r.dr ?? 2) };
      });
      data = [1, 2, 3, 4, 5, 6, 7].map((dow) => ({
        day: DAY_LABELS_KO[dow === 7 ? 0 : dow],
        dayLabel: DAY_LABELS_EN[dow === 7 ? 0 : dow],
        passRate: byDay[dow]?.passRate ?? 98,
        defectRate: byDay[dow]?.defectRate ?? 2,
        inspected: 0,
      }));
    } else {
      const [rows] = await conn.query<any[]>(
        `SELECT YEARWEEK(\`${dateCol}\`) as yw, ${prSel}, ${drSel}
         FROM \`${table}\` WHERE \`${dateCol}\` >= DATE_SUB(CURDATE(), INTERVAL 28 DAY)
         GROUP BY YEARWEEK(\`${dateCol}\`) ORDER BY yw LIMIT 4`
      );
      data = (rows || []).map((r, i) => ({
        week: `${i + 1}주`,
        passRate: Number(r.pr ?? 98),
        defectRate: Number(r.dr ?? 2),
      }));
    }

    let byLine: { line: string; passRate: number; status: string }[] = [];
    if (lineCol && prCol) {
      const [lineRows] = await conn.query<any[]>(
        `SELECT \`${lineCol}\` as line_name, AVG(\`${prCol}\`) as pr
         FROM \`${table}\` WHERE \`${dateCol}\` >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
         GROUP BY \`${lineCol}\``
      );
      byLine = (lineRows || []).map((r) => ({
        line: String(r.line_name ?? r[lineCol] ?? ''),
        passRate: Number(r.pr ?? 98),
        status: Number(r.pr) >= 99 ? 'excellent' : Number(r.pr) >= 98 ? 'good' : 'normal',
      }));
    }

    conn.release();
    conn = null;
    return NextResponse.json({ success: true, period, data, byLine });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Quality API error:', msg);
    return NextResponse.json(
      { success: false, error: msg, period, data: [], byLine: [] },
      { status: 500 }
    );
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (e) {
        console.error('Error releasing connection:', e);
      }
    }
  }
}
