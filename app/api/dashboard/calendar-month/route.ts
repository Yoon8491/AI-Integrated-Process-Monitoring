import { NextResponse } from 'next/server';
import {
  getConnection,
  getProcessDataTable,
  getProcessColumnMap,
  escapeSqlId,
} from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** cathode_data 메타데이터 기준: 컬럼명 → 생산량 단위 (한글, 영문) */
function getProductionUnit(col: string | null, hasQty: boolean): { unitKo: string; unitEn: string } {
  if (!hasQty || !col) return { unitKo: '건', unitEn: 'records' }; // COUNT(*) → 기록 건수
  const lower = col.toLowerCase();
  if (lower.includes('lithium') || lower === 'lithium_input') return { unitKo: 'kg', unitEn: 'kg' };
  if (/quantity|amount|count|qty|output|생산|수량/.test(lower)) return { unitKo: '개', unitEn: 'ea' };
  return { unitKo: '개', unitEn: 'ea' };
}

/** 금월 일별 생산량·불량률 (캘린더용) */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const year = searchParams.get('year') ? parseInt(searchParams.get('year')!, 10) : new Date().getFullYear();
  const month = searchParams.get('month') ? parseInt(searchParams.get('month')!, 10) : new Date().getMonth() + 1;

  let conn;
  try {
    conn = await getConnection();
    const tableName = await getProcessDataTable(conn);
    if (!tableName) {
      conn.release();
      conn = null;
      return NextResponse.json({ success: true, year, month, days: [], productionUnit: '개', productionUnitEn: 'ea' });
    }

    const map = await getProcessColumnMap(conn, tableName);
    const { dateCol, quantityCol, passRateCol, defectCol, resultCol } = map;
    if (!dateCol) {
      conn.release();
      conn = null;
      return NextResponse.json({ success: true, year, month, days: [], productionUnit: '개', productionUnitEn: 'ea' });
    }

    const hasQty = quantityCol != null;
    const { unitKo: productionUnit, unitEn: productionUnitEn } = getProductionUnit(quantityCol, hasQty);
    const qtyCol = quantityCol || 'id';
    const quantitySel = hasQty ? `COALESCE(SUM(${escapeSqlId(qtyCol)}), 0)` : 'COUNT(*)';

    // 불량률: DB는 원시값만 조회. 0~1 비율/0~100% 변환은 JS에서 처리 (calendar-month에서 normalizeDefectRate)
    // prediction은 0=합격, 1=불합격이므로 AVG를 하면 불량률이 됨 (0~1 범위)
    // defect_rate 같은 비율 컬럼은 이미 0~1 또는 0~100 범위
    let defectRateSel: string;
    if (resultCol) {
      // prediction 같은 경우: AVG하면 불량률 (0~1 범위)
      // 예: 10개 중 3개 불량 → AVG = 0.3 → 30%
      defectRateSel = `AVG(COALESCE(CAST(${escapeSqlId(resultCol)} AS DECIMAL(10,4)), 0))`;
    } else if (defectCol) {
      // defect_rate 같은 비율 컬럼인지 확인
      const isRateColumn = /rate|percent|pct|ratio/i.test(defectCol);
      if (isRateColumn) {
        // 이미 비율 컬럼인 경우 (0~1 또는 0~100)
        defectRateSel = `AVG(COALESCE(${escapeSqlId(defectCol)}, 0))`;
      } else {
        // 0/1 불량 여부 컬럼인 경우
        defectRateSel = `AVG(COALESCE(CAST(${escapeSqlId(defectCol)} AS DECIMAL(10,4)), 0))`;
      }
    } else if (passRateCol) {
      // 합격률에서 불량률 계산: passRate가 0~1 범위면 (1-passRate), 0~100 범위면 (100-passRate)
      // 일단 0~1 범위로 가정하고 계산, 프론트엔드에서 정규화
      defectRateSel = `(1 - AVG(COALESCE(${escapeSqlId(passRateCol)}, 1)))`;
    } else {
      defectRateSel = '0';
    }

    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = new Date(year, month, 0);

    const [rows]: any = await conn.query(
      `SELECT DAY(${escapeSqlId(dateCol)}) as d, ${quantitySel} as production, ${defectRateSel} as defect_rate
       FROM ${escapeSqlId(tableName)}
       WHERE ${escapeSqlId(dateCol)} >= ? AND ${escapeSqlId(dateCol)} < DATE_ADD(?, INTERVAL 1 MONTH)
       GROUP BY DATE(${escapeSqlId(dateCol)})
       ORDER BY d`,
      [monthStart, monthStart]
    );

    const byDay: Record<number, { production: number; defectRate: number }> = {};
    // 불량률: DB가 0~1 비율이면 *100, 이미 0~100 퍼센트면 100 초과 시 상한 적용
    // prediction의 경우 AVG하면 이미 0~1 범위의 불량률이 됨
    const normalizeDefectRate = (raw: number): number => {
      if (raw == null || !Number.isFinite(raw)) return 0;
      // 이미 % 단위로 저장된 경우 (예: 8 → 8%)
      if (raw > 1) return Math.min(100, raw);
      // 0~1 비율인 경우 (prediction의 AVG 또는 defect_rate)
      return Math.min(100, raw * 100);
    };
    (rows || []).forEach((r: any) => {
      const d = Number(r.d);
      byDay[d] = {
        production: Number(r.production ?? 0),
        defectRate: normalizeDefectRate(Number(r.defect_rate ?? 0)),
      };
    });

    const lastDay = monthEnd.getDate();
    const days = Array.from({ length: lastDay }, (_, i) => {
      const day = i + 1;
      const data = byDay[day] ?? { production: 0, defectRate: 0 };
      return { day, production: data.production, defectRate: data.defectRate };
    });

    conn.release();
    conn = null;
    return NextResponse.json({ success: true, year, month, lastDay, days, productionUnit, productionUnitEn });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Calendar month API error:', msg);
    return NextResponse.json(
      { success: false, error: msg, year, month, days: [], productionUnit: '개', productionUnitEn: 'ea' },
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
