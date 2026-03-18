import type { FastifyInstance } from 'fastify';
import { getConnection, getTables, getProcessDataTable, getProcessColumnMap, getTodayDateString } from '../../lib/dashboard-db.js';
import { requireAuth } from '../../middlewares/auth.js';

export async function registerDashboardSummary(app: FastifyInstance) {
  app.get('/api/dashboard/summary', async (request, reply) => {
    const user = await requireAuth(request as any);
    if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized' });

    let conn: any;
    try {
      conn = await getConnection();
      const tables = await getTables(conn);
      const processTable = await getProcessDataTable(conn);
      const map = await getProcessColumnMap(conn, processTable);
      const { table, dateCol, quantityCol, passRateCol, consumptionCol, efficiencyCol } = map;

      const todayStr = getTodayDateString();
      const dateCondition = dateCol ? `WHERE DATE(\`${dateCol}\`) = ?` : '';
      const dateCondition1d = dateCol
        ? `WHERE DATE(\`${dateCol}\`) = ?`
        : '';

      let productionToday: number | null = null;
      let equipmentRate: number | null = null;
      let qualityRate: number | null = null;
      let energyToday: number | null = null;
      const usedTables: string[] = [processTable];

      if (quantityCol && dateCol) {
        const [rows]: any = await conn.query(
          `SELECT COALESCE(SUM(\`${quantityCol}\`), 0) as total FROM \`${table}\` ${dateCondition}`,
          [todayStr]
        );
        productionToday = Number(rows?.[0]?.total ?? 0);
      }

      if (efficiencyCol && dateCol) {
        const [rows]: any = await conn.query(
          `SELECT AVG(\`${efficiencyCol}\`) as avg_rate FROM \`${table}\` ${dateCondition1d}`,
          [todayStr]
        );
        const v = rows?.[0]?.avg_rate;
        equipmentRate = v != null ? Number(v) : null;
      }

      if (passRateCol && dateCol) {
        const [rows]: any = await conn.query(
          `SELECT AVG(\`${passRateCol}\`) as avg_rate FROM \`${table}\` ${dateCondition1d}`,
          [todayStr]
        );
        const v = rows?.[0]?.avg_rate;
        qualityRate = v != null ? Number(v) : null;
      }

      if (consumptionCol && dateCol) {
        const [rows]: any = await conn.query(
          `SELECT COALESCE(SUM(\`${consumptionCol}\`), 0) as total FROM \`${table}\` ${dateCondition}`,
          [todayStr]
        );
        energyToday = Number(rows?.[0]?.total ?? 0);
      }

      const fromDb =
        productionToday != null ||
        equipmentRate != null ||
        qualityRate != null ||
        energyToday != null;

      conn.release();

      return reply.send({
        success: true,
        data: {
          productionToday: productionToday ?? undefined,
          equipmentRate: equipmentRate ?? undefined,
          qualityRate: qualityRate ?? undefined,
          energyToday: energyToday ?? undefined,
        },
        fromDb,
        tables,
        usedTables: fromDb ? usedTables : [],
        columnMap: fromDb ? map : null,
      });
    } catch (e: unknown) {
      const err = e as { sql?: string; sqlMessage?: string; code?: string };
      console.error('[dashboard/summary] DB error:', e);
      if (err?.sql) console.error('[dashboard/summary] SQL:', err.sql);
      if (err?.sqlMessage) console.error('[dashboard/summary] sqlMessage:', err.sqlMessage);
      const msg = e instanceof Error ? e.message : String(e);
      request.log.error({ err: e }, 'Dashboard summary error');
      if (conn) try { conn.release(); } catch {}
      return reply.code(500).send({
        success: false,
        error: msg,
        data: {},
        fromDb: false,
        tables: [],
        usedTables: [],
        columnMap: null,
      });
    }
  });
}

