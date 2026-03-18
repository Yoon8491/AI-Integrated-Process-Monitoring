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
    const { table, dateCol, efficiencyCol, lineCol } = map;
    const effCol = efficiencyCol || map.numericCols.find((n) => /rate|efficiency|uptime|oee/i.test(n)) || map.numericCols[0];
    if (!dateCol) {
      conn.release();
      conn = null;
      return NextResponse.json({ success: true, period, data: [], byLine: [] });
    }

    let data: { day?: string; dayLabel?: string; week?: string; time?: string; efficiency: number; uptime: number; downtime?: number }[] = [];
    const effSel = effCol ? `AVG(\`${effCol}\`) as eff` : '85 as eff';

    if (period === 'day') {
      const [rows] = await conn.query<any[]>(
        `SELECT HOUR(\`${dateCol}\`) as h, ${effSel}
         FROM \`${table}\` WHERE DATE(\`${dateCol}\`) = CURDATE()
         GROUP BY HOUR(\`${dateCol}\`) ORDER BY h`
      );
      data = (rows || []).map((r) => ({
        time: `${String(r.h).padStart(2, '0')}:00`,
        efficiency: Number(r.eff ?? 85),
        uptime: Number(r.eff ?? 95),
      }));
    } else if (period === 'week') {
      const [rows] = await conn.query<any[]>(
        `SELECT DAYOFWEEK(\`${dateCol}\`) as dow, ${effSel}
         FROM \`${table}\` WHERE \`${dateCol}\` >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
         GROUP BY DATE(\`${dateCol}\`) ORDER BY DATE(\`${dateCol}\`)`
      );
      const byDay: Record<number, number> = {};
      (rows || []).forEach((r) => {
        const dow = Number(r.dow ?? 1);
        byDay[dow] = Number(r.eff ?? 85);
      });
      data = [1, 2, 3, 4, 5, 6, 7].map((dow) => ({
        day: DAY_LABELS_KO[dow === 7 ? 0 : dow],
        dayLabel: DAY_LABELS_EN[dow === 7 ? 0 : dow],
        efficiency: byDay[dow] ?? 85,
        uptime: byDay[dow] ?? 95,
        downtime: 100 - (byDay[dow] ?? 95),
      }));
    } else {
      const [rows] = await conn.query<any[]>(
        `SELECT YEARWEEK(\`${dateCol}\`) as yw, ${effSel}
         FROM \`${table}\` WHERE \`${dateCol}\` >= DATE_SUB(CURDATE(), INTERVAL 28 DAY)
         GROUP BY YEARWEEK(\`${dateCol}\`) ORDER BY yw LIMIT 4`
      );
      data = (rows || []).map((r, i) => ({
        week: `${i + 1}주`,
        efficiency: Number(r.eff ?? 85),
        uptime: Number(r.eff ?? 95),
      }));
    }

    let byLine: { line: string; efficiency: number; uptime: number; status: string; issues: number }[] = [];
    if (lineCol && effCol) {
      const [lineRows] = await conn.query<any[]>(
        `SELECT \`${lineCol}\` as line_name, AVG(\`${effCol}\`) as eff
         FROM \`${table}\` WHERE \`${dateCol}\` >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
         GROUP BY \`${lineCol}\``
      );
      byLine = (lineRows || []).map((r) => {
        const eff = Number(r.eff ?? 85);
        return {
          line: String(r.line_name ?? r[lineCol] ?? ''),
          efficiency: eff,
          uptime: eff,
          status: eff >= 90 ? 'excellent' : eff >= 85 ? 'good' : 'normal',
          issues: 0,
        };
      });
    }

    conn.release();
    conn = null;
    return NextResponse.json({ success: true, period, data, byLine });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Efficiency API error:', msg);
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
