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
    const { table, dateCol, quantityCol, lineCol } = map;
    const valueCol = quantityCol || map.numericCols[0];
    if (!dateCol || !valueCol) {
      conn.release();
      conn = null;
      return NextResponse.json({ success: true, period, data: [], byLine: [] });
    }

    let data: { day?: string; dayLabel?: string; week?: string; time?: string; value: number; target?: number }[] = [];

    if (period === 'day') {
      const [rows] = await conn.query<any[]>(
        `SELECT HOUR(\`${dateCol}\`) as h, COALESCE(SUM(\`${valueCol}\`), 0) as v
         FROM \`${table}\` WHERE DATE(\`${dateCol}\`) = CURDATE()
         GROUP BY HOUR(\`${dateCol}\`) ORDER BY h`
      );
      data = (rows || []).map((r) => ({
        time: `${String(r.h).padStart(2, '0')}:00`,
        value: Number(r.v ?? 0),
      }));
    } else if (period === 'week') {
      const [rows] = await conn.query<any[]>(
        `SELECT DAYOFWEEK(\`${dateCol}\`) as dow, COALESCE(SUM(\`${valueCol}\`), 0) as v
         FROM \`${table}\` WHERE \`${dateCol}\` >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
         GROUP BY DATE(\`${dateCol}\`) ORDER BY DATE(\`${dateCol}\`)`
      );
      const byDay: Record<number, number> = {};
      (rows || []).forEach((r) => {
        const dow = Number(r.dow ?? 1);
        byDay[dow] = (byDay[dow] || 0) + Number(r.v ?? 0);
      });
      data = [1, 2, 3, 4, 5, 6, 7].map((dow) => ({
        day: DAY_LABELS_KO[dow === 7 ? 0 : dow],
        dayLabel: DAY_LABELS_EN[dow === 7 ? 0 : dow],
        value: byDay[dow] ?? 0,
        target: 1200,
      }));
    } else {
      const [rows] = await conn.query<any[]>(
        `SELECT YEARWEEK(\`${dateCol}\`) as yw, COALESCE(SUM(\`${valueCol}\`), 0) as v
         FROM \`${table}\` WHERE \`${dateCol}\` >= DATE_SUB(CURDATE(), INTERVAL 28 DAY)
         GROUP BY YEARWEEK(\`${dateCol}\`) ORDER BY yw LIMIT 4`
      );
      data = (rows || []).map((r, i) => ({
        week: `${i + 1}주`,
        value: Number(r.v ?? 0),
        target: 5000,
      }));
    }

    let byLine: { name: string; production: number; status: string; efficiency: number }[] = [];
    if (lineCol && period === 'week') {
      const [lineRows] = await conn.query<any[]>(
        `SELECT \`${lineCol}\` as line_name, COALESCE(SUM(\`${valueCol}\`), 0) as total
         FROM \`${table}\` WHERE \`${dateCol}\` >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
         GROUP BY \`${lineCol}\``
      );
      byLine = (lineRows || []).map((r) => ({
        name: String(r.line_name ?? r[lineCol] ?? ''),
        production: Number(r.total ?? 0),
        status: 'normal',
        efficiency: 85,
      }));
    }

    conn.release();
    conn = null;
    return NextResponse.json({ success: true, period, data, byLine });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Production API error:', msg);
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
