import type { FastifyInstance } from 'fastify';
import { getConnection, getChartDataTable, getColumns, getTodayDateString, getComparisonTable, escapeSqlId } from '../../lib/dashboard-db.js';
import { requireAuth } from '../../middlewares/auth.js';

const RECENT_LIMIT = 50;

type SensorData = {
  name: string;
  nameKorean: string;
  currentValue: number;
  previousValue: number;
  trend: 'up' | 'down' | 'stable';
  changePercent: number;
  unit: string;
};

function isSensorColumn(col: string): boolean {
  const sensorKeywords = [
    'temperature',
    'temp',
    'humidity',
    'pressure',
    'voltage',
    'current',
    'power',
    'energy',
    'speed',
    'flow',
    'level',
    'rpm',
    'vibration',
    '온도',
    '습도',
    '압력',
    '전압',
    '전류',
    '전력',
  ];
  const lower = col.toLowerCase();
  return sensorKeywords.some((k) => lower.includes(k));
}

function getSensorInfo(col: string): { korean: string; unit: string } {
  const lower = col.toLowerCase();
  if (lower.includes('temp')) return { korean: '온도', unit: '°C' };
  if (lower.includes('humidity')) return { korean: '습도', unit: '%' };
  if (lower.includes('tank') && lower.includes('pressure')) return { korean: '탱크 압력', unit: 'kPa' };
  if (lower.includes('pressure')) return { korean: '압력', unit: 'kPa' };
  if (lower.includes('voltage')) return { korean: '전압', unit: 'V' };
  if (lower.includes('current')) return { korean: '전류', unit: 'A' };
  if (lower.includes('power') || lower.includes('energy')) return { korean: '전력', unit: 'kW' };
  if (lower.includes('speed')) return { korean: '속도', unit: 'm/s' };
  if (lower.includes('flow')) return { korean: '유량', unit: 'L/min' };
  if (lower.includes('level')) return { korean: '레벨', unit: '%' };
  if (lower.includes('rpm')) return { korean: '회전수', unit: 'RPM' };
  if (lower.includes('vibration')) return { korean: '진동', unit: 'mm/s' };
  return { korean: col, unit: '' };
}

export async function registerDashboardRealtime(app: FastifyInstance) {
  app.get('/api/dashboard/realtime', async (request, reply) => {
    const user = await requireAuth(request as any);
    if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized', sensors: [], history: [] });

    let conn: any;
    try {
      const searchParams = (request.query || {}) as any;
      const includeHistory = String(searchParams.history) === 'true';
      const historyPeriod = String(searchParams.period || 'recent');
      const historyDate = searchParams.date ? String(searchParams.date) : null;

      conn = await getConnection();
      const tableName = await getChartDataTable(conn);
      const columns = await getColumns(conn, tableName);
      const numericCols = columns
        .filter((c) => /int|decimal|float|double/i.test(c.type))
        .map((c) => c.name);
      const sensorCols = numericCols.filter(isSensorColumn);

      if (sensorCols.length === 0) {
        conn.release();
        return reply.send({ success: true, sensors: [], message: 'NO_SENSOR_COLUMNS' });
      }

      const dateCol = columns.find(
        (c) => /date|time|created|recorded/i.test(c.name) || /date|time/i.test(c.type)
      )?.name;

      const orderBy = dateCol ? `ORDER BY \`${dateCol}\` DESC` : '';
      const colList = sensorCols.map((c) => `\`${c}\``).join(', ');
      const [rows]: any = await conn.query(
        `SELECT ${colList} FROM \`${tableName}\` ${orderBy} LIMIT ${RECENT_LIMIT}`
      );

      if (!rows || rows.length < 2) {
        conn.release();
        return reply.send({ success: true, sensors: [], message: 'INSUFFICIENT_DATA' });
      }

      const sensors: SensorData[] = [];
      for (const col of sensorCols) {
        const values = rows
          .map((r: any) => r[col])
          .filter((v: any) => v != null && !Number.isNaN(Number(v)))
          .map((v: any) => Number(v));
        if (values.length < 2) continue;

        const currentValue = values[0];
        const previousValue = values[1];
        const avgPrevious =
          values.slice(1, 6).reduce((a: number, b: number) => a + b, 0) /
          Math.min(5, values.length - 1);

        const changePercent = avgPrevious !== 0 ? ((currentValue - avgPrevious) / avgPrevious) * 100 : 0;
        let trend: 'up' | 'down' | 'stable' = 'stable';
        if (Math.abs(changePercent) > 2) trend = changePercent > 0 ? 'up' : 'down';

        const { korean, unit } = getSensorInfo(col);
        sensors.push({
          name: col,
          nameKorean: korean,
          currentValue,
          previousValue,
          trend,
          changePercent,
          unit,
        });
      }

      let history: { time: string; [key: string]: string | number | null }[] = [];
      let comparisonMeta:
        | {
            chartTable: string;
            comparisonTable?: string;
            monthlyAvg?: Record<string, number>;
            matchedRows?: number;
            diffRows?: number;
          }
        | undefined;
      if (includeHistory && dateCol) {
        const historyCols = [...sensorCols];
        if (numericCols.includes('anomaly_depth') && !historyCols.includes('anomaly_depth')) {
          historyCols.push('anomaly_depth');
        }
        const historyColList = historyCols.map((c) => `\`${c}\``).join(', ');
        const todayStr = getTodayDateString();
        const dayWhere =
          historyDate && /^\d{4}-\d{2}-\d{2}$/.test(historyDate)
            ? ` WHERE DATE(\`${dateCol}\`) = ?`
            : historyPeriod === 'day'
              ? ` WHERE DATE(\`${dateCol}\`) = ?`
              : '';
        const dayParams =
          historyDate && /^\d{4}-\d{2}-\d{2}$/.test(historyDate)
            ? [historyDate]
            : historyPeriod === 'day'
              ? [todayStr]
              : [];
        const useDayFilter =
          historyPeriod === 'day' || (historyDate && /^\d{4}-\d{2}-\d{2}$/.test(historyDate));
        const historyOrder = useDayFilter
          ? ` ORDER BY \`${dateCol}\` ASC`
          : ` ORDER BY \`${dateCol}\` DESC LIMIT 50`;
        const dayLimit = useDayFilter ? ' LIMIT 5000' : '';

        const [historyRows]: any =
          dayParams.length > 0
            ? await conn.query(
                `SELECT \`${dateCol}\` as time, ${historyColList}
                 FROM \`${tableName}\`${dayWhere}${historyOrder}${dayLimit}`,
                dayParams
              )
            : await conn.query(
                `SELECT \`${dateCol}\` as time, ${historyColList}
                 FROM \`${tableName}\`${dayWhere}${historyOrder}${dayLimit}`
              );

        const rawRows = (historyRows || []).map((r: any) => {
          const timeVal = r.time;
          const timeStr = timeVal instanceof Date ? timeVal.toISOString() : String(timeVal ?? '');
          const row: { time: string; [key: string]: string | number | null } = { time: timeStr };
          for (const col of historyCols) {
            row[col] = Number(r[col] ?? 0);
          }
          return row;
        });
        history = useDayFilter ? rawRows : rawRows.reverse();

        // 해당 달 평균 (차트에 기존 색 점선으로 표시). 날짜 선택 시 그 달 전체 평균, 아니면 현재 구간 평균
        const preprocAvg: Record<string, number> = {};
        if (dayParams.length > 0 && dayParams[0]) {
          const [y, m] = (dayParams[0] as string).split('-').map(Number);
          const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
          const nextMonth = m === 12 ? [y + 1, 1] : [y, m + 1];
          const monthEnd = `${nextMonth[0]}-${String(nextMonth[1]).padStart(2, '0')}-01`;
          const avgColList = sensorCols.map((c) => `AVG(${escapeSqlId(c)}) as ${escapeSqlId(c)}`).join(', ');
          const [avgRows]: any = await conn.query(
            `SELECT ${avgColList} FROM ${escapeSqlId(tableName)}
             WHERE \`${dateCol}\` >= ? AND \`${dateCol}\` < ?`,
            [monthStart, monthEnd]
          );
          const ar = (avgRows && avgRows[0]) || {};
          for (const col of sensorCols) {
            const v = ar[col];
            preprocAvg[col] = v != null && !Number.isNaN(Number(v)) ? Number(v) : 0;
          }
        } else {
          for (const col of sensorCols) {
            const vals = history.map((r) => Number(r[col]));
            const valid = vals.filter((v) => !Number.isNaN(v));
            preprocAvg[col] = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
          }
        }
        for (const row of history) {
          for (const col of sensorCols) {
            (row as Record<string, unknown>)[`${col}_avg`] = preprocAvg[col];
          }
        }

        // 비교용 테이블(예: data_sample)이 있으면 같은 시간대 값 조회 후 _compare 로 붙임
        const comparisonTableName = await getComparisonTable(conn);
        if (comparisonTableName) {
          const compColumns = await getColumns(conn, comparisonTableName);
          const compDateCol = compColumns.find(
            (c) => /date|time|created|recorded|timestamp/i.test(c.name) || /date|time/i.test(c.type)
          )?.name;
          const compNumeric = compColumns
            .filter((c) => /int|decimal|float|double/i.test(c.type))
            .map((c) => c.name);
          const compareSensorCols = sensorCols.filter((c) => compNumeric.includes(c));
          if (compDateCol && compareSensorCols.length > 0) {
            const dayWhere =
              historyDate && /^\d{4}-\d{2}-\d{2}$/.test(historyDate)
                ? [historyDate]
                : historyPeriod === 'day'
                  ? [todayStr]
                  : [];
            const compColList = compareSensorCols.map((c) => `${escapeSqlId(c)}`).join(', ');
            const compWhere =
              dayWhere.length > 0
                ? ` WHERE DATE(${escapeSqlId(compDateCol)}) = ?`
                : '';
            const [compRows]: any = await conn.query(
              `SELECT ${escapeSqlId(compDateCol)} as time, ${compColList}
               FROM ${escapeSqlId(comparisonTableName)}${compWhere}
               ORDER BY ${escapeSqlId(compDateCol)} ASC
               LIMIT 5000`,
              dayWhere
            );
            // 시간 포맷 통일: "YYYY-MM-DD HH:mm:ss" / "YYYY-MM-DDTHH:mm:ss.000Z" → "YYYY-MM-DDTHH:mm:ss"
            const toCanonicalTime = (val: unknown): string => {
              if (val instanceof Date) return val.toISOString().replace(/\.\d{3}Z$/, '').slice(0, 19);
              const s = String(val ?? '').trim();
              const replaced = s.replace(' ', 'T').replace(/\.\d+Z?$/i, '').replace(/Z$/i, '');
              return replaced.slice(0, 19);
            };
            const compareByTime = new Map<string, Record<string, number>>();
            for (const r of compRows || []) {
              const key = toCanonicalTime(r.time);
              const ent: Record<string, number> = {};
              for (const col of compareSensorCols) {
                const v = r[col];
                ent[col] = v != null && !Number.isNaN(Number(v)) ? Number(v) : 0;
              }
              compareByTime.set(key, ent);
            }
            for (const row of history) {
              const key = toCanonicalTime(row.time);
              let comp = compareByTime.get(key);
              if (!comp) {
                const keys = Array.from(compareByTime.keys());
                const nearest = keys.find(
                  (k) => k.slice(0, 16) === key.slice(0, 16) || k.startsWith(key.slice(0, 13))
                );
                comp = nearest ? compareByTime.get(nearest)! : {};
              }
              for (const col of sensorCols) {
                (row as Record<string, unknown>)[`${col}_compare`] =
                  col in comp ? (comp[col] as number) : null;
              }
            }
          }
        }
        // data_sample과 다른 지점 표시용 (빨간 점): _diff true 이면 해당 시점·센서를 빨간 점으로 표시
        const EPS = 1e-9;
        for (const row of history) {
          for (const col of sensorCols) {
            const mainVal = Number((row as Record<string, unknown>)[col]);
            const compareVal = (row as Record<string, unknown>)[`${col}_compare`];
            const hasCompare = compareVal != null && !Number.isNaN(Number(compareVal));
            const diff = hasCompare && Math.abs(mainVal - Number(compareVal)) > EPS;
            (row as Record<string, unknown>)[`${col}_diff`] = diff;
          }
        }
        const rowsWithCompare = history.filter(
          (r) => sensorCols.some((c) => (r as Record<string, unknown>)[`${c}_compare`] != null)
        ).length;
        const rowsWithDiff = history.filter(
          (r) => sensorCols.some((c) => (r as Record<string, unknown>)[`${c}_diff`] === true)
        ).length;
        comparisonMeta = {
          chartTable: tableName,
          comparisonTable: comparisonTableName ?? undefined,
          monthlyAvg: Object.keys(preprocAvg).length ? preprocAvg : undefined,
          matchedRows: rowsWithCompare,
          diffRows: rowsWithDiff,
        };
      }

      conn.release();
      return reply.send({
        success: true,
        sensors,
        history,
        totalSensors: sensors.length,
        dataPoints: rows.length,
        ...(comparisonMeta && { comparisonMeta }),
      });
    } catch (e: unknown) {
      const err = e as { sql?: string; sqlMessage?: string; code?: string };
      console.error('[dashboard/realtime] DB error:', e);
      if (err?.sql) console.error('[dashboard/realtime] SQL:', err.sql);
      if (err?.sqlMessage) console.error('[dashboard/realtime] sqlMessage:', err.sqlMessage);
      const msg = e instanceof Error ? e.message : String(e);
      request.log.error({ err: e }, 'Realtime API error');
      if (conn) try { conn.release(); } catch {}
      return reply.code(500).send({ success: false, error: msg, sensors: [] });
    }
  });
}

