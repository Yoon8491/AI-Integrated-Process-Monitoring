import { NextResponse } from 'next/server';
import {
  getConnection,
  getProcessDataTable,
  getProcessColumnMap,
  getColumns,
} from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LOTS = 50; // 최대 LOT 수

type HeatmapCell = {
  lot: string;
  hour: number;
  passRate: number;
  defectRate: number;
  count: number;
};

export async function GET() {
  let conn;
  try {
    conn = await getConnection();
    const processTable = await getProcessDataTable(conn);
    if (!processTable) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        data: [],
        lots: [],
        hours: [],
        message: 'NO_TABLE',
      });
    }

    const map = await getProcessColumnMap(conn, processTable);
    const { dateCol, passRateCol, defectCol, lotCol } = map;

    if (!dateCol || (!passRateCol && !defectCol)) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        data: [],
        lots: [],
        hours: [],
        message: 'NO_REQUIRED_COLUMNS',
      });
    }

    const lotColName = lotCol ?? (await getColumns(conn, processTable)).find((c) => /lot|batch/i.test(c.name))?.name;
    if (!lotColName) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        data: [],
        lots: [],
        hours: [],
        message: 'NO_LOT_COLUMN',
      });
    }

    const qualityCol = passRateCol || defectCol;
    const isDefectCol = !passRateCol && defectCol;

    // 최근 LOT들의 시간대별 품질 데이터 조회
    const [rows]: any = await conn.query(
      `SELECT 
        \`${lotColName}\` as lot,
        HOUR(\`${dateCol}\`) as hour,
        AVG(\`${qualityCol}\`) as quality_value,
        COUNT(*) as cnt
       FROM \`${processTable}\`
       WHERE \`${dateCol}\` >= DATE_SUB(NOW(), INTERVAL 7 DAY)
         AND \`${lotColName}\` IS NOT NULL
         AND \`${qualityCol}\` IS NOT NULL
       GROUP BY \`${lotColName}\`, HOUR(\`${dateCol}\`)
       ORDER BY \`${dateCol}\` DESC
       LIMIT 500`
    );

    if (!rows || rows.length === 0) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        data: [],
        lots: [],
        hours: [],
        message: 'NO_DATA',
      });
    }

    // 데이터 변환
    const heatmapData: HeatmapCell[] = rows.map((r) => {
      const qualityValue = Number(r.quality_value ?? 0);
      const passRate = isDefectCol ? 100 - qualityValue : qualityValue;
      const defectRate = isDefectCol ? qualityValue : 100 - qualityValue;

      return {
        lot: String(r.lot ?? ''),
        hour: Number(r.hour ?? 0),
        passRate,
        defectRate,
        count: Number(r.cnt ?? 0),
      };
    });

    // 고유 LOT, 시간대 추출
    const uniqueLots = [...new Set(heatmapData.map((d) => d.lot))].slice(0, MAX_LOTS);
    const uniqueHours = [...new Set(heatmapData.map((d) => d.hour))].sort((a, b) => a - b);

    conn.release();
    conn = null;

    return NextResponse.json({
      success: true,
      data: heatmapData,
      lots: uniqueLots,
      hours: uniqueHours,
      totalLots: uniqueLots.length,
      totalHours: uniqueHours.length,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Quality heatmap API error:', msg);
    return NextResponse.json(
      {
        success: false,
        error: msg,
        data: [],
        lots: [],
        hours: [],
      },
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
