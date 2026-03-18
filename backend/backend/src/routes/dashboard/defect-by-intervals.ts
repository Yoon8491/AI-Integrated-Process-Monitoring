import type { FastifyInstance } from 'fastify';
import { getConnection, getProcessDataTable, getProcessColumnMap, getColumns } from '../../lib/dashboard-db.js';
import { requireAuth } from '../../middlewares/auth.js';

const MAX_ROWS = 5000;
const DEFAULT_BINS = 5;

/** 구간별 불량률: 파라미터별로 값 구간을 나누고 각 구간의 평균 불량률 반환 */
export async function registerDashboardDefectByIntervals(app: FastifyInstance) {
  app.get('/api/dashboard/defect-by-intervals', async (request, reply) => {
    const user = await requireAuth(request as any);
    if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized' });

    const q = (request.query || {}) as any;
    const params = q.params ? (Array.isArray(q.params) ? q.params : String(q.params).split(',')).map((p: string) => p.trim()).filter(Boolean) : null;
    const numBins = Math.min(10, Math.max(2, parseInt(String(q.bins), 10) || DEFAULT_BINS));

    let conn: any;
    try {
      conn = await getConnection();
      const processTable = await getProcessDataTable(conn);
      const map = await getProcessColumnMap(conn, processTable);
      const cols = await getColumns(conn, processTable);
      const numericCols = cols
        .filter((c) => /int|decimal|float|double/i.test(c.type))
        .map((c) => c.name);

      const defectCol = map.defectCol || map.passRateCol;
      const resultCol = map.resultCol;
      const skipCols = new Set([
        map.dateCol,
        map.lotCol,
        defectCol,
        resultCol,
        map.passRateCol,
        map.quantityCol,
      ].filter(Boolean).map((c) => c!.toLowerCase()));

      const paramCandidates = numericCols.filter(
        (name) => !skipCols.has(name.toLowerCase()) && !/pass|rate|quality|defect|result|lot|date|id/i.test(name)
      );

      const preferredNames = ['humidity', 'lithium_input'];
      const preferred = paramCandidates.filter((c) => preferredNames.some((p) => p.toLowerCase() === c.toLowerCase()));
      const rest = paramCandidates.filter((c) => !preferred.some((p) => p.toLowerCase() === c.toLowerCase()));
      const defaultParams = [...preferred, ...rest].slice(0, 9);

      const requestedParams = params && params.length > 0
        ? params.filter((p: string) => numericCols.includes(p))
        : defaultParams;

      if (requestedParams.length === 0 || !defectCol) {
        conn.release();
        return reply.send({
          success: true,
          intervals: [],
          error: !defectCol ? 'NO_DEFECT_COL' : 'NO_PARAMS',
        });
      }

      const colList = [...new Set([...requestedParams, defectCol])].map((c) => `\`${c}\``).join(', ');
      const resultColSel = resultCol ? `, \`${resultCol}\`` : '';
      const [rows]: any = await conn.query(
        `SELECT ${colList}${resultColSel} FROM \`${processTable}\` WHERE \`${defectCol}\` IS NOT NULL LIMIT ${MAX_ROWS}`
      );
      const data = rows || [];

      const isDefectRate = /rate|percent|pct|ratio/i.test(defectCol);
      const toDefectRate = (r: any): number => {
        const v = r[defectCol];
        if (v == null) return NaN;
        const n = typeof v === 'number' ? v : parseFloat(v);
        if (Number.isNaN(n)) return NaN;
        return isDefectRate && n > 1 ? n / 100 : n;
      };

      const getRowVal = (r: any, col: string): unknown => {
        if (r[col] !== undefined && r[col] !== null) return r[col];
        const lower = col.toLowerCase();
        const key = Object.keys(r).find((k) => k.toLowerCase() === lower);
        return key != null ? r[key] : undefined;
      };

      // 다른 변수들(rest)이 유효한 행만 공통 사용 → humidity/lithium_input 포함 모든 변수가 같은 데이터 사용
      const restParams = requestedParams.filter((p: string) => !['humidity', 'lithium_input'].includes(p.toLowerCase()));
      const commonData = data.filter((r: any) => {
        const y = toDefectRate(r);
        if (y == null || Number.isNaN(y)) return false;
        if (restParams.length === 0) return true;
        for (const p of restParams) {
          const v = getRowVal(r, p);
          if (v == null || Number.isNaN(Number(v))) return false;
        }
        return true;
      });

      const intervals: {
        paramName: string;
        bins: { label: string; min: number; max: number; defectRate: number; count: number }[];
        averageDefectRate: number;
      }[] = [];

      for (const paramName of requestedParams) {
        const validRows = commonData.filter((r: any) => {
          const v = getRowVal(r, paramName);
          return v != null && !Number.isNaN(Number(v));
        });
        const points = validRows.map((r: any) => ({
          x: Number(getRowVal(r, paramName)),
          y: toDefectRate(r),
        }));
        const nullRows = commonData.filter((r: any) => {
          const v = getRowVal(r, paramName);
          return v == null || Number.isNaN(Number(v));
        });

        const totalCount = commonData.length;
        const totalDefectRate =
          totalCount > 0 ? commonData.reduce((s: number, r: any) => s + toDefectRate(r), 0) / totalCount : 0;

        const bins: { label: string; min: number; max: number; defectRate: number; count: number }[] = [];

        if (points.length > 0) {
          const minX = Math.min(...points.map((p: { x: number }) => p.x));
          const maxX = Math.max(...points.map((p: { x: number }) => p.x));
          const span = maxX - minX;
          const width = span <= 0 ? 1 : span / numBins;

          const binBuckets: { x: number; y: number }[][] = Array.from({ length: numBins }, () => []);
          for (const p of points) {
            let idx = span <= 0 ? 0 : Math.floor((p.x - minX) / width);
            if (idx >= numBins) idx = numBins - 1;
            if (idx < 0) idx = 0;
            binBuckets[idx].push(p);
          }

          for (let i = 0; i < numBins; i++) {
            const slice = binBuckets[i];
            const min = minX + i * width;
            const max = i === numBins - 1 ? maxX : minX + (i + 1) * width;
            const defectRate = slice.length > 0 ? slice.reduce((s: number, p: { x: number; y: number }) => s + p.y, 0) / slice.length : 0;
            bins.push({
              label: `${Number(min).toFixed(4)} - ${Number(max).toFixed(4)}`,
              min,
              max,
              defectRate,
              count: slice.length,
            });
          }
        }

        if (nullRows.length > 0) {
          const nullDefectRate = nullRows.reduce((s: number, r: any) => s + toDefectRate(r), 0) / nullRows.length;
          bins.push({
            label: '미측정',
            min: NaN,
            max: NaN,
            defectRate: nullDefectRate,
            count: nullRows.length,
          });
        }

        intervals.push({
          paramName,
          bins,
          averageDefectRate: totalDefectRate,
        });
      }

      conn.release();
      return reply.send({ success: true, intervals });
    } catch (e: unknown) {
      const err = e as { sql?: string; sqlMessage?: string };
      console.error('[dashboard/defect-by-intervals] error:', e);
      if (conn) try { conn.release(); } catch {}
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(500).send({ success: false, error: msg, intervals: [] });
    }
  });
}
