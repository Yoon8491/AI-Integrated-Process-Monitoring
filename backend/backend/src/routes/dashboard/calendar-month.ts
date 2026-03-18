import type { FastifyInstance } from 'fastify';
import { getConnection, getProcessDataTable, getProcessColumnMap } from '../../lib/dashboard-db.js';
import { requireAuth } from '../../middlewares/auth.js';

function getProductionUnit(col: string | null, hasQty: boolean): { unitKo: string; unitEn: string } {
  if (!hasQty || !col) return { unitKo: '건', unitEn: 'records' };
  const lower = col.toLowerCase();
  if (lower.includes('lithium') || lower === 'lithium_input') return { unitKo: 'kg', unitEn: 'kg' };
  if (/quantity|amount|count|qty|output|생산|수량/.test(lower)) return { unitKo: '개', unitEn: 'ea' };
  return { unitKo: '개', unitEn: 'ea' };
}

export async function registerDashboardCalendarMonth(app: FastifyInstance) {
  app.get('/api/dashboard/calendar-month', async (request, reply) => {
    const user = await requireAuth(request as any);
    if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized', days: [] });

    const q = (request.query || {}) as any;
    const year = q.year ? parseInt(String(q.year), 10) : new Date().getFullYear();
    const month = q.month ? parseInt(String(q.month), 10) : new Date().getMonth() + 1;

    let conn: any;
    try {
      conn = await getConnection();
      const tableName = await getProcessDataTable(conn);
      const map = await getProcessColumnMap(conn, tableName);
      const { dateCol, quantityCol, passRateCol, defectCol, resultCol } = map;
      if (!dateCol) {
        conn.release();
        return reply.send({ success: true, year, month, days: [], productionUnit: '개', productionUnitEn: 'ea' });
      }

      const hasQty = quantityCol != null;
      const { unitKo: productionUnit, unitEn: productionUnitEn } = getProductionUnit(quantityCol, hasQty);
      const qtyCol = quantityCol || 'id';
      const quantitySel = hasQty ? `COALESCE(SUM(\`${qtyCol}\`), 0)` : 'COUNT(*)';

      // 불량률: quality_defect는 0=합격, 1=불합격이므로 AVG하면 불량률 (0~1 범위)
      // 프론트엔드에서 *100을 하므로 백엔드는 0~1 범위로 반환
      let defectRateSel: string;
      if (resultCol) {
        // quality_defect: AVG하면 불량률 (0~1 범위), 프론트엔드에서 *100
        defectRateSel = `AVG(COALESCE(CAST(\`${resultCol}\` AS DECIMAL(10,4)), 0))`;
      } else if (defectCol) {
        // defect_rate 같은 비율 컬럼인지 확인
        const isRateColumn = /rate|percent|pct|ratio/i.test(defectCol);
        if (isRateColumn) {
          // 이미 비율 컬럼 (0~1 또는 0~100)
          defectRateSel = `AVG(COALESCE(\`${defectCol}\`, 0))`;
        } else {
          // 0/1 불량 여부 컬럼
          defectRateSel = `AVG(COALESCE(CAST(\`${defectCol}\` AS DECIMAL(10,4)), 0))`;
        }
      } else if (passRateCol) {
        // 합격률에서 불량률 계산: (1 - passRate) * 100
        defectRateSel = `(1 - AVG(COALESCE(\`${passRateCol}\`, 1)))`;
      } else {
        defectRateSel = '0';
      }

      const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
      const monthEnd = new Date(year, month, 0);
      const [rows]: any = await conn.query(
        `SELECT DAY(\`${dateCol}\`) as d, ${quantitySel} as production, ${defectRateSel} as defect_rate
         FROM \`${tableName}\`
         WHERE \`${dateCol}\` >= ? AND \`${dateCol}\` < DATE_ADD(?, INTERVAL 1 MONTH)
         GROUP BY DATE(\`${dateCol}\`)
         ORDER BY d`,
        [monthStart, monthStart]
      );

      const byDay: Record<number, { production: number; defectRate: number }> = {};
      (rows || []).forEach((r: any) => {
        const d = Number(r.d);
        byDay[d] = {
          production: Number(r.production ?? 0),
          defectRate: Number(r.defect_rate ?? 0),
        };
      });

      const lastDay = monthEnd.getDate();
      const days = Array.from({ length: lastDay }, (_, i) => {
        const day = i + 1;
        const data = byDay[day] ?? { production: 0, defectRate: 0 };
        return { day, production: data.production, defectRate: data.defectRate };
      });

      conn.release();
      return reply.send({ success: true, year, month, lastDay, days, productionUnit, productionUnitEn });
    } catch (e: unknown) {
      const err = e as { sql?: string; sqlMessage?: string; code?: string };
      console.error('[dashboard/calendar-month] DB error:', e);
      if (err?.sql) console.error('[dashboard/calendar-month] SQL:', err.sql);
      if (err?.sqlMessage) console.error('[dashboard/calendar-month] sqlMessage:', err.sqlMessage);
      const msg = e instanceof Error ? e.message : String(e);
      request.log.error({ err: e }, 'Calendar month API error');
      if (conn) try { conn.release(); } catch {}
      return reply.code(500).send({ success: false, error: msg, year, month, days: [], productionUnit: '개', productionUnitEn: 'ea' });
    }
  });
}

