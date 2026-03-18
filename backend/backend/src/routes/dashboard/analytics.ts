import type { FastifyInstance } from 'fastify';
import { getConnection, getProcessDataTable, getProcessColumnMap, getColumns } from '../../lib/dashboard-db.js';
import { requireAuth } from '../../middlewares/auth.js';

const MAX_ROWS = 1000;

/** 불량 영향 변수로 사용할 컬럼명 패턴 (lithium_input, additive_ratio, process_time, sintering_temp, humidity, tank_pressure) */
const ALLOWED_IMPORTANCE_PATTERNS = [
  /^lithium[_ ]?input|lithiuminput$/i,
  /^additive[_ ]?ratio|additive[_ ]?ration|additiveratio$/i,
  /^process[_ ]?time|processtime|processing[_ ]?time$/i,
  /^sintering[_ ]?temp|sinteringtemp|sintering[_ ]?temperature$/i,
  /^humidity$/i,
  /^tank[_ ]?pressure|tankpressure$/i,
];

function isAllowedImportanceColumn(colName: string): boolean {
  const n = colName.replace(/\s+/g, '_').toLowerCase();
  return ALLOWED_IMPORTANCE_PATTERNS.some((re) => re.test(n));
}

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const meanX = sum(x) / n;
  const meanY = sum(y) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] ?? meanX) - meanX;
    const dy = (y[i] ?? meanY) - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

function toNumericMatrix(rows: Record<string, unknown>[], columns: string[]): number[][] {
  return columns.map((col) =>
    rows.map((r) => {
      const v = (r as any)[col];
      if (typeof v === 'number' && !Number.isNaN(v)) return v;
      if (typeof v === 'string') return parseFloat(v) || 0;
      return 0;
    })
  );
}

export async function registerDashboardAnalytics(app: FastifyInstance) {
  app.get('/api/dashboard/analytics', async (request, reply) => {
    const user = await requireAuth(request as any);
    if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized' });

    let conn: any;
    try {
      conn = await getConnection();
      const processTable = await getProcessDataTable(conn);
      const map = await getProcessColumnMap(conn, processTable);
      const cols = await getColumns(conn, processTable);
      const numericCols = cols
        .filter((c) => /int|decimal|float|double/i.test(c.type))
        .map((c) => c.name);

      if (numericCols.length === 0) {
        conn.release();
        return reply.send({
          success: true,
          correlation: { columns: [], matrix: [] },
          importance: [],
          confusionMatrix: null,
          error: 'NO_NUMERIC',
        });
      }

      const colList = numericCols.map((c) => `\`${c}\``).join(', ');
      const [rows]: any = await conn.query(`SELECT ${colList} FROM \`${processTable}\` LIMIT ${MAX_ROWS}`);
      const data = rows || [];

      if (data.length < 2) {
        conn.release();
        return reply.send({
          success: true,
          correlation: { columns: numericCols, matrix: numericCols.map(() => numericCols.map(() => 0)) },
          importance: numericCols.map((name) => ({ name, importance: 0 })),
          confusionMatrix: null,
        });
      }

      const matrix = toNumericMatrix(data, numericCols);
      const n = numericCols.length;
      const corrMatrix: number[][] = [];
      for (let i = 0; i < n; i++) {
        corrMatrix[i] = [];
        for (let j = 0; j < n; j++) {
          corrMatrix[i][j] = i === j ? 1 : pearson(matrix[i], matrix[j]);
        }
      }

      // 불량 영향 변수: minseo FastAPI(전처리+모델 Pearson) 우선, 실패 시 DB probability 상관
      let importance: { name: string; importance: number }[] = [];
      const probabilityCol = numericCols.find((c) => /^probability$|^prob$|defect_probability/i.test(c));
      let targetCol = probabilityCol || map.defectCol || map.passRateCol || map.quantityCol || numericCols[0];
      const minseoUrl = process.env.MINSEO_API_URL?.replace(/\/$/, '');
      if (minseoUrl) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const res = await fetch(`${minseoUrl}/api/probability-correlation?limit=5000`, {
            signal: controller.signal,
          });
          const json = (await res.json()) as {
            success?: boolean;
            importance?: { name: string; importance: number }[];
            targetColumn?: string;
          };
          if (json?.success && Array.isArray(json.importance) && json.importance.length > 0) {
            importance = json.importance.slice(0, 6);
            targetCol = json.targetColumn ?? 'probability';
          }
        } catch (e) {
          request.log.warn({ err: e }, '[Analytics] Minseo correlation API failed, using fallback');
        } finally {
          clearTimeout(timeout);
        }
      }
      if (importance.length === 0) {
        const targetIdx = numericCols.indexOf(targetCol);
        const targetVec = targetIdx >= 0 ? matrix[targetIdx] : matrix[0];
        const importanceColIndices = numericCols
          .map((name, i) => ({ name, i }))
          .filter(({ name }) => isAllowedImportanceColumn(name));
        importance = importanceColIndices.map(({ name, i }) => ({
          name,
          importance: Math.abs(pearson(matrix[i], targetVec)),
        }));
        importance.sort((a, b) => b.importance - a.importance);
        importance = importance.filter((item) => item.name !== targetCol);
        const excludeFromRank = ['prediction', 'probability', 'metal_impurity', 'd50'];
        importance = importance
          .filter((item) => !excludeFromRank.some((ex) => item.name.toLowerCase() === ex.toLowerCase()))
          .slice(0, 6);
      }

      let confusionMatrix: {
        labels: { actual: string[]; predicted: string[] };
        matrix: number[][];
        summary: { tp: number; fp: number; tn: number; fn: number; accuracy: number };
      } | null = null;

      const outcomeCol =
        map.passRateCol ||
        map.defectCol ||
        numericCols.find((n) => /pass|defect|quality|rate/i.test(n)) ||
        numericCols[0];
      const outcomeIdx = numericCols.indexOf(outcomeCol);
      if (outcomeIdx >= 0) {
        const values = matrix[outcomeIdx];
        const median = values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
        const thresholdActual = median;
        const thresholdPred = median * 0.98;
        let tp = 0, fp = 0, tn = 0, fn = 0;
        for (let i = 0; i < values.length; i++) {
          const actualPos = values[i] >= thresholdActual;
          const predPos = values[i] >= thresholdPred;
          if (actualPos && predPos) tp++;
          else if (!actualPos && predPos) fp++;
          else if (actualPos && !predPos) fn++;
          else tn++;
        }
        const total = tp + fp + tn + fn;
        confusionMatrix = {
          labels: { actual: ['Negative', 'Positive'], predicted: ['Negative', 'Positive'] },
          matrix: [
            [tn, fp],
            [fn, tp],
          ],
          summary: {
            tp, fp, tn, fn,
            accuracy: total > 0 ? (tp + tn) / total : 0,
          },
        };
      }

      // 불량 LOT 분석
      let defectLots: { lot: string; defectRate: number; variables: Record<string, number> }[] = [];
      const defectCol = map.defectCol || map.passRateCol;
      const lotCol = cols.find((c) => /lot|batch/i.test(c.name))?.name;

      if (defectCol && lotCol) {
        const [defectRows]: any = await conn.query(
          `SELECT \`${lotCol}\` as lot, \`${defectCol}\` as defect_rate, ${colList}
           FROM \`${processTable}\`
           WHERE \`${defectCol}\` IS NOT NULL
           ORDER BY \`${defectCol}\` DESC
           LIMIT 10`
        );
        defectLots = (defectRows || []).map((r: any) => ({
          lot: String(r.lot ?? ''),
          defectRate: Number(r.defect_rate ?? 0),
          variables: Object.fromEntries(numericCols.map((col) => [col, Number(r[col] ?? 0)])),
        }));
      }

      // 불량률 추이(시계열). 캘린더와 동일하게 0~1 비율은 0~100%로 정규화
      const normalizeDefectRate = (raw: number): number => {
        if (raw == null || !Number.isFinite(raw)) return 0;
        if (raw > 1) return Math.min(100, raw);
        return Math.min(100, raw * 100);
      };
      // 불량률 추이: 한 점 = 하루, 최근 60일
      let defectTrend: { time: string; defectRate: number; passRate: number }[] = [];
      if (defectCol && map.dateCol) {
        const isDefectCol = defectCol === map.defectCol;
        const [trendRows]: any = await conn.query(
          `SELECT 
            DATE(\`${map.dateCol}\`) as time_day,
            AVG(\`${defectCol}\`) as avg_rate
           FROM \`${processTable}\`
           WHERE \`${defectCol}\` IS NOT NULL
             AND DATE(\`${map.dateCol}\`) >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
             AND DATE(\`${map.dateCol}\`) <= CURDATE()
           GROUP BY DATE(\`${map.dateCol}\`)
           ORDER BY time_day ASC
           LIMIT 100`
        );

        defectTrend = (trendRows || []).map((r: any) => {
          const avgRate = Number(r.avg_rate ?? 0);
          const defectRaw = isDefectCol ? avgRate : 1 - avgRate;
          const normalized = normalizeDefectRate(defectRaw);
          const timeDay = String(r.time_day ?? '');
          return {
            time: /^\d{4}-\d{2}-\d{2}$/.test(timeDay) ? `${timeDay} 00:00:00` : timeDay,
            defectRate: normalized,
            passRate: Math.min(100, 100 - normalized),
          };
        });
      }

      conn.release();
      return reply.send({
        success: true,
        correlation: { columns: numericCols, matrix: corrMatrix },
        importance,
        confusionMatrix,
        defectLots,
        defectTrend,
        targetColumn: targetCol,
      });
    } catch (e: unknown) {
      const err = e as { sql?: string; sqlMessage?: string; code?: string };
      console.error('[dashboard/analytics] DB error:', e);
      if (err?.sql) console.error('[dashboard/analytics] SQL:', err.sql);
      if (err?.sqlMessage) console.error('[dashboard/analytics] sqlMessage:', err.sqlMessage);
      const msg = e instanceof Error ? e.message : String(e);
      request.log.error({ err: e }, 'Analytics API error');
      if (conn) try { conn.release(); } catch {}
      return reply.code(500).send({
        success: false,
        error: msg,
        correlation: { columns: [], matrix: [] },
        importance: [],
        confusionMatrix: null,
      });
    }
  });
}

