import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middlewares/auth.js';
import { authQuery } from '../../db.js';

/** LOT별 공정현황 달력: lot_defect_reports 기준. 과거~오늘 넓은 범위로 조회 가능 */
export async function registerLotStatusDateRange(app: FastifyInstance) {
  app.get('/api/dashboard/lot-status-date-range', async (request, reply) => {
    const user = await requireAuth(request as any);
    if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized', minDate: null, maxDate: null });

    try {
      const rows: any = await authQuery(
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

      const minDate = dbMin && dbMin < fallbackMin ? dbMin : fallbackMin;
      const maxDate = (dbMax && dbMax > today ? dbMax : today);

      return reply.send({
        success: true,
        minDate,
        maxDate,
      });
    } catch (e) {
      console.error('[lot-status-date-range] error:', e);
      const today = new Date().toISOString().slice(0, 10);
      return reply.code(500).send({ success: false, error: String(e), minDate: today, maxDate: today });
    }
  });
}
