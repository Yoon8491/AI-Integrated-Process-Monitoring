import type { FastifyInstance } from 'fastify';
import { getConnection, getProcessDataTable, getColumns } from '../../lib/dashboard-db.js';
import { requireAuth } from '../../middlewares/auth.js';

const SIGMA_MULTIPLIER = 3;
const RECENT_LIMIT = 100;

type Alert = {
  column: string;
  columnKorean: string;
  currentValue: number;
  mean: number;
  stdDev: number;
  upperLimit: number;
  lowerLimit: number;
  deviation: number;
  severity: 'warning' | 'critical';
};

function columnToKorean(col: string): string {
  const dict: Record<string, string> = {
    temperature: '온도',
    temp: '온도',
    humidity: '습도',
    pressure: '압력',
    voltage: '전압',
    current: '전류',
    power: '전력',
    energy: '에너지',
    speed: '속도',
    weight: '무게',
    thickness: '두께',
    density: '밀도',
    flow: '유량',
    lithium_input: '리튬 투입량',
    cobalt_input: '코발트 투입량',
    nickel_input: '니켈 투입량',
  };
  const lower = col.toLowerCase();
  for (const [en, ko] of Object.entries(dict)) {
    if (lower.includes(en)) return ko;
  }
  return col;
}

export async function registerDashboardAlerts(app: FastifyInstance) {
  app.get('/api/dashboard/alerts', async (request, reply) => {
    const user = await requireAuth(request as any);
    if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized', alerts: [] });

    let conn: any;
    try {
      conn = await getConnection();
      const tableName = await getProcessDataTable(conn);
      const columns = await getColumns(conn, tableName);
      const numericCols = columns
        .filter((c) => /int|decimal|float|double/i.test(c.type))
        .map((c) => c.name);

      if (numericCols.length === 0) {
        conn.release();
        return reply.send({ success: true, alerts: [], message: 'NO_NUMERIC_COLUMNS' });
      }

      const dateCol = columns.find(
        (c) => /date|time|created|recorded/i.test(c.name) || /date|time/i.test(c.type)
      )?.name;

      const orderBy = dateCol ? `ORDER BY \`${dateCol}\` DESC` : '';
      const colList = numericCols.map((c) => `\`${c}\``).join(', ');

      const [rows]: any = await conn.query(
        `SELECT ${colList} FROM \`${tableName}\` ${orderBy} LIMIT ${RECENT_LIMIT}`
      );

      if (!rows || rows.length < 10) {
        conn.release();
        return reply.send({ success: true, alerts: [], message: 'INSUFFICIENT_DATA' });
      }

      const alerts: Alert[] = [];
      for (const col of numericCols) {
        const values = rows
          .map((r: any) => r[col])
          .filter((v: any) => v != null && !Number.isNaN(Number(v)))
          .map((v: any) => Number(v));
        if (values.length < 10) continue;

        const mean = values.reduce((a: number, b: number) => a + b, 0) / values.length;
        const variance =
          values.reduce((a: number, b: number) => a + Math.pow(b - mean, 2), 0) / values.length;
        const stdDev = Math.sqrt(variance);
        if (stdDev === 0) continue;

        const upperLimit = mean + SIGMA_MULTIPLIER * stdDev;
        const lowerLimit = mean - SIGMA_MULTIPLIER * stdDev;
        const currentValue = values[0];

        if (currentValue > upperLimit || currentValue < lowerLimit) {
          const deviation = Math.abs((currentValue - mean) / stdDev);
          const severity: 'warning' | 'critical' = deviation > 3 ? 'critical' : 'warning';
          alerts.push({
            column: col,
            columnKorean: columnToKorean(col),
            currentValue,
            mean,
            stdDev,
            upperLimit,
            lowerLimit,
            deviation,
            severity,
          });
        }
      }

      alerts.sort((a, b) => {
        if (a.severity === 'critical' && b.severity !== 'critical') return -1;
        if (a.severity !== 'critical' && b.severity === 'critical') return 1;
        return b.deviation - a.deviation;
      });

      conn.release();
      return reply.send({
        success: true,
        alerts,
        totalAlerts: alerts.length,
        criticalCount: alerts.filter((a) => a.severity === 'critical').length,
        warningCount: alerts.filter((a) => a.severity === 'warning').length,
        dataPoints: rows.length,
      });
    } catch (e: unknown) {
      const err = e as { sql?: string; sqlMessage?: string; code?: string };
      console.error('[dashboard/alerts] DB error:', e);
      if (err?.sql) console.error('[dashboard/alerts] SQL:', err.sql);
      if (err?.sqlMessage) console.error('[dashboard/alerts] sqlMessage:', err.sqlMessage);
      const msg = e instanceof Error ? e.message : String(e);
      request.log.error({ err: e }, 'Alerts API error');
      if (conn) try { conn.release(); } catch {}
      return reply.code(500).send({ success: false, error: msg, alerts: [] });
    }
  });
}

