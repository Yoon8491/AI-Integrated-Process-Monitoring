import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middlewares/auth.js';
import { authQuery } from '../../db.js';

/** LOT별 공정현황 달력: 해당 월에 lot_defect_reports에 데이터가 있는 날짜(YYYY-MM-DD) 목록. 선택 가능한 날만 표시 */
export async function registerLotStatusDatesInMonth(app: FastifyInstance) {
  app.get('/api/dashboard/lot-status-dates-in-month', async (request, reply) => {
    const user = await requireAuth(request as any);
    if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized', dates: [] });

    const q = (request.query || {}) as any;
    const year = q.year ? parseInt(String(q.year), 10) : new Date().getFullYear();
    const month = q.month ? parseInt(String(q.month), 10) : new Date().getMonth() + 1;

    try {
      const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
      const monthEnd = new Date(year, month, 0);
      const monthEndStr = `${year}-${String(month).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`;

      const rows: any = await authQuery(
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

      return reply.send({ success: true, dates });
    } catch (e) {
      console.error('[lot-status-dates-in-month] error:', e);
      return reply.code(500).send({ success: false, error: String(e), dates: [] });
    }
  });
}
