import { NextResponse } from 'next/server';
import {
  getConnection,
  getProcessDataTable,
  getProcessColumnMap,
  getColumns,
  escapeSqlId,
  isSafeColumnName,
} from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getProductionUnit(col: string | null, hasQty: boolean): { unitKo: string; unitEn: string } {
  if (!hasQty || !col) return { unitKo: '건', unitEn: 'records' };
  const lower = col.toLowerCase();
  if (lower.includes('lithium') || lower === 'lithium_input') return { unitKo: 'kg', unitEn: 'kg' };
  if (/quantity|amount|count|qty|output|생산|수량/.test(lower)) return { unitKo: '개', unitEn: 'ea' };
  return { unitKo: '개', unitEn: 'ea' };
}

/** 주간(7일) 일별 총 생산량(LOT 리튬 투입량 합계)·불량률(불합격 LOT 수/전체 LOT 수*100). start=YYYY-MM-DD (월요일 기준), 7일치 반환 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const startParam = searchParams.get('start');
  if (!startParam || !/^\d{4}-\d{2}-\d{2}$/.test(startParam)) {
    return NextResponse.json(
      { success: false, error: 'start (YYYY-MM-DD) required', days: [] },
      { status: 400 }
    );
  }

  const startDate = new Date(startParam + 'T00:00:00');
  if (Number.isNaN(startDate.getTime())) {
    return NextResponse.json(
      { success: false, error: 'Invalid start date', days: [] },
      { status: 400 }
    );
  }

  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 6);
  const startStr = startParam;
  const endStr = endDate.getFullYear() + '-' + String(endDate.getMonth() + 1).padStart(2, '0') + '-' + String(endDate.getDate()).padStart(2, '0');

  let conn;
  try {
    conn = await getConnection();
    const tableName = await getProcessDataTable(conn);
    if (!tableName) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        start: startStr,
        end: endStr,
        days: [],
        productionUnit: '개',
        productionUnitEn: 'ea',
      });
    }

    const map = await getProcessColumnMap(conn, tableName);
    const { dateCol, quantityCol, lotCol, resultCol } = map;
    if (!dateCol) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        start: startStr,
        end: endStr,
        days: [],
        productionUnit: '개',
        productionUnitEn: 'ea',
      });
    }

    const allCols = await getColumns(conn, tableName);
    const colNames = (allCols || []).map((c) => c.name);
    const hasLithium = colNames.some((n) => n.toLowerCase() === 'lithium_input' || n.toLowerCase().includes('lithium'));
    const lithiumCol = hasLithium && isSafeColumnName('lithium_input')
      ? 'lithium_input'
      : colNames.find((n) => /lithium/i.test(n) && isSafeColumnName(n)) ?? null;
    const productionCol = lithiumCol ?? quantityCol;
    const hasQty = productionCol != null;
    const { unitKo: productionUnit, unitEn: productionUnitEn } = getProductionUnit(productionCol, hasQty);
    const qtySel = hasQty ? `COALESCE(SUM(${escapeSqlId(productionCol)}), 0)` : 'COUNT(*)';

    let rows: any[] = [];

    if (lotCol && resultCol && isSafeColumnName(lotCol) && isSafeColumnName(resultCol)) {
      // 일별 생산량 = 해당 일자 전체 LOT 리튬 투입량(또는 생산량) 합계. 불량률 = (불합격 LOT 수 / 전체 LOT 수) * 100
      const innerQty = hasQty ? `AVG(${escapeSqlId(productionCol)})` : '1';
      const innerFail = `MAX(CASE WHEN TRIM(CAST(${escapeSqlId(resultCol)} AS CHAR)) IN ('1', '불합격', 'fail', 'NG') OR CAST(${escapeSqlId(resultCol)} AS DECIMAL(10,4)) = 1 THEN 1 ELSE 0 END)`;
      const [innerRows]: any = await conn.query(
        `SELECT DATE(${escapeSqlId(dateCol)}) as dt, ${escapeSqlId(lotCol)} as lot_id, ${innerQty} as lithium_per_lot, ${innerFail} as is_fail
         FROM ${escapeSqlId(tableName)}
         WHERE ${escapeSqlId(dateCol)} >= ? AND ${escapeSqlId(dateCol)} < DATE_ADD(?, INTERVAL 7 DAY)
         GROUP BY DATE(${escapeSqlId(dateCol)}), ${escapeSqlId(lotCol)}`,
        [startStr, startStr]
      );
      if (innerRows && (innerRows as any[]).length > 0) {
        const byDate: Record<string, { production: number; total: number; failed: number }> = {};
        for (const r of innerRows as any[]) {
          const dt = r.dt ? String(r.dt).slice(0, 10) : '';
          if (!dt) continue;
          const prod = Number(r.lithium_per_lot) || 0;
          const fail = Number(r.is_fail) ? 1 : 0;
          if (!byDate[dt]) byDate[dt] = { production: 0, total: 0, failed: 0 };
          byDate[dt].production += prod;
          byDate[dt].total += 1;
          byDate[dt].failed += fail;
        }
        rows = Object.entries(byDate).map(([dt, o]) => ({
          dt,
          production: o.production,
          defect_rate: o.total > 0 ? (o.failed / o.total) * 100 : 0,
        }));
      }
    }

    if (rows.length === 0) {
      const quantitySel = hasQty ? qtySel : 'COUNT(*)';
      const defectRateSel = resultCol && isSafeColumnName(resultCol)
        ? `SUM(CASE WHEN TRIM(CAST(${escapeSqlId(resultCol)} AS CHAR)) IN ('1', '불합격', 'fail', 'NG') OR CAST(${escapeSqlId(resultCol)} AS DECIMAL(10,4)) = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)`
        : '0';
      const [simpleRows]: any = await conn.query(
        `SELECT DATE(${escapeSqlId(dateCol)}) as dt, ${quantitySel} as production, ${defectRateSel} as defect_rate
         FROM ${escapeSqlId(tableName)}
         WHERE ${escapeSqlId(dateCol)} >= ? AND ${escapeSqlId(dateCol)} < DATE_ADD(?, INTERVAL 7 DAY)
         GROUP BY DATE(${escapeSqlId(dateCol)})
         ORDER BY dt`,
        [startStr, startStr]
      );
      rows = simpleRows || [];
    }

    const normalizeDefectRate = (raw: number): number => {
      if (raw == null || !Number.isFinite(raw)) return 0;
      if (raw > 100) return 100;
      if (raw > 1) return Math.min(100, raw);
      return Math.min(100, raw * 100);
    };

    const byDate: Record<string, { production: number; defectRate: number }> = {};
    (rows || []).forEach((r: any) => {
      const dt = r.dt ? String(r.dt).slice(0, 10) : '';
      if (dt) {
        const rawProd = r.production ?? r.production_amount ?? 0;
        const rawDefect = r.defect_rate ?? r.defectRate ?? 0;
        byDate[dt] = {
          production: Number(rawProd) != null && !Number.isNaN(Number(rawProd)) ? Number(rawProd) : 0,
          defectRate: normalizeDefectRate(Number(rawDefect)),
        };
      }
    });

    const days: { date: string; production: number; defectRate: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const data = byDate[dateStr] ?? { production: 0, defectRate: 0 };
      days.push({
        date: dateStr,
        production: Number.isFinite(data.production) ? data.production : 0,
        defectRate: Number.isFinite(data.defectRate) ? data.defectRate : 0,
      });
    }

    conn.release();
    conn = null;
    return NextResponse.json({
      success: true,
      start: startStr,
      end: endStr,
      days,
      productionUnit,
      productionUnitEn,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Calendar week API error:', msg);
    return NextResponse.json(
      { success: false, error: msg, start: startStr, end: endStr, days: [], productionUnit: '개', productionUnitEn: 'ea' },
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
