import { NextRequest, NextResponse } from 'next/server';
import {
  getConnection,
  getProcessDataTable,
  getProcessColumnMap,
  getColumns,
  getTables,
  escapeSqlId,
} from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 주요 변수 구간별 불량률 분석 API.
 * - 기본: preprocessing 오늘 제외·어제까지 최근 60일 데이터 기준. preprocessing에 없는 변수(metal_impurity, d50)와 prediction은 simulation_results에서 조인.
 * - preprocessing 없으면: simulation_results에서 prediction IS NOT NULL 행 최대 MAX_ROWS.
 */
const MAX_ROWS = 10000;
const PREP_DAYS = 60;
/** 60일 × 24시간 × 6(10분 단위) = 8640 */
const EXPECTED_PREP_ROWS = 8640;
const DEFAULT_BINS = 5;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const paramsParam = searchParams.get('params');
  const params = paramsParam ? paramsParam.split(',').map((p) => p.trim()).filter(Boolean) : null;
  const numBins = Math.min(10, Math.max(2, parseInt(searchParams.get('bins') || '', 10) || DEFAULT_BINS));

  let conn;
  try {
    conn = await getConnection();
    const processTable = await getProcessDataTable(conn);
    const map = await getProcessColumnMap(conn, processTable);
    const cols = await getColumns(conn, processTable);
    const numericCols = cols
      .filter((c) => /int|decimal|float|double/i.test(c.type))
      .map((c) => c.name);

    const defectCol = map.defectCol || map.passRateCol;
    const skipCols = new Set(
      [
        map.dateCol,
        map.lotCol,
        defectCol,
        map.resultCol,
        map.passRateCol,
        map.quantityCol,
      ].filter(Boolean).map((c) => c!.toLowerCase())
    );

    // 구간 나누는 변수: 지정 8개 (테이블에 존재하는 것만 사용). 불량 컬럼은 getProcessColumnMap에서 prediction 등으로 매핑.
    const DEFAULT_INTERVAL_PARAMS = [
      'additive_ratio',
      'process_time',
      'tank_pressure',
      'sintering_temp',
      'humidity',
      'lithium_input',
      'metal_impurity',
      'd50',
    ];
    const excludeFromIntervals = ['probability'];
    const defaultParams = DEFAULT_INTERVAL_PARAMS.map((p) => numericCols.find((c) => c.toLowerCase() === p.toLowerCase()))
      .filter((c): c is string => c != null)
      .filter((c) => !excludeFromIntervals.some((ex) => ex.toLowerCase() === c.toLowerCase()));

    const requestedParams =
      params && params.length > 0
        ? params
            .filter((p: string) => numericCols.includes(p) && !excludeFromIntervals.some((ex) => ex.toLowerCase() === p.toLowerCase()))
            .slice(0, 10)
        : defaultParams;

    if (requestedParams.length === 0 || !defectCol) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        intervals: [],
        error: !defectCol ? 'NO_DEFECT_COL' : 'NO_PARAMS',
      });
    }

    const srDateCol = map.dateCol || 'timestamp';
    let data: any[] = [];

    const tables = await getTables(conn);
    const hasPreprocessing = tables.some((t) => String(t).toLowerCase() === 'preprocessing');
    let prepCols: { name: string; type: string }[] = [];
    let prepDateCol: string | null = null;
    const prepTable = 'preprocessing';

    if (hasPreprocessing) {
      prepCols = await getColumns(conn, prepTable);
      const isDateType = (type: string) => /date|time|timestamp/i.test(String(type));
      prepDateCol = prepCols.find((c) => isDateType(c.type) || /timestamp|date|time/i.test(c.name))?.name ?? null;
    }

    const paramInPrep = (paramName: string): string | null => {
      const found = prepCols.find((c) => c.name.toLowerCase() === paramName.toLowerCase());
      return found ? found.name : null;
    };
    // prediction, d50, metal_impurity는 preprocessing에 NULL이 있어도 simulation_results 값만 사용
    const alwaysFromSr = (p: string) => ['metal_impurity', 'd50'].includes(p.toLowerCase());

    if (hasPreprocessing && prepDateCol && prepCols.length > 0) {
      const srOnlyParams = requestedParams.filter((p) => alwaysFromSr(p) || paramInPrep(p) == null);
      const prepParams = requestedParams.filter((p) => !alwaysFromSr(p) && paramInPrep(p) != null);
      const selectParts: string[] = [
        `sr.${escapeSqlId(defectCol)}`, // prediction: 항상 simulation_results
        ...srOnlyParams.map((c) => `sr.${escapeSqlId(c)}`),
        ...prepParams.map((p) => {
          const prepName = paramInPrep(p)!;
          return `prep.${escapeSqlId(prepName)} AS ${escapeSqlId(p)}`;
        }),
      ];
      const resultColSel = map.resultCol ? `, sr.${escapeSqlId(map.resultCol)}` : '';
      // preprocessing 60일을 서브쿼리로 먼저 선택(최대 8640행) 후 LEFT JOIN → prep 행 수가 그대로 유지됨
      const sql = `SELECT ${selectParts.join(', ')}${resultColSel}
        FROM (
          SELECT * FROM ${escapeSqlId(prepTable)}
          WHERE ${escapeSqlId(prepDateCol)} >= DATE_SUB(CURDATE(), INTERVAL ${PREP_DAYS} DAY)
            AND ${escapeSqlId(prepDateCol)} < CURDATE()
          ORDER BY ${escapeSqlId(prepDateCol)} DESC
          LIMIT ${EXPECTED_PREP_ROWS}
        ) prep
        LEFT JOIN ${escapeSqlId(processTable)} sr ON prep.${escapeSqlId(prepDateCol)} = sr.${escapeSqlId(srDateCol)}
        ORDER BY prep.${escapeSqlId(prepDateCol)} DESC`;
      try {
        const [rows]: any = await conn.query(sql);
        data = rows || [];
      } catch (joinErr) {
        console.warn('[defect-by-intervals] preprocessing 60d join failed, using simulation_results only:', joinErr);
      }
    }

    if (data.length === 0) {
      const colList = [...new Set([...requestedParams, defectCol])].map((c) => escapeSqlId(c)).join(', ');
      const resultColSel = map.resultCol ? `, ${escapeSqlId(map.resultCol)}` : '';
      const [rows]: any = await conn.query(
        `SELECT ${colList}${resultColSel} FROM ${escapeSqlId(processTable)} WHERE ${escapeSqlId(defectCol)} IS NOT NULL LIMIT ${MAX_ROWS}`
      );
      data = rows || [];
    }

    const isDefectRate = /rate|percent|pct|ratio/i.test(defectCol);
    const toDefectRate = (r: any): number => {
      const v = r[defectCol];
      if (v == null) return NaN;
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (Number.isNaN(n)) return NaN;
      return isDefectRate && n > 1 ? n / 100 : n;
    };

    // 행에서 컬럼 값 가져오기 (DB 대소문자 차이 대비)
    const getRowVal = (r: any, col: string): unknown => {
      if (r[col] !== undefined && r[col] !== null) return r[col];
      const lower = col.toLowerCase();
      const key = Object.keys(r).find((k) => k.toLowerCase() === lower);
      return key != null ? r[key] : undefined;
    };

    // 다른 변수들(rest)이 유효한 행만 공통 사용 → humidity/lithium_input 포함 모든 변수가 같은 데이터(예: 950건) 사용
    const restParams = requestedParams.filter((p) => !['humidity', 'lithium_input'].includes(p.toLowerCase()));
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
        totalCount > 0 ? commonData.reduce((s, r) => s + toDefectRate(r), 0) / totalCount : 0;

      const bins: { label: string; min: number; max: number; defectRate: number; count: number }[] = [];

      if (points.length > 0) {
        const minX = Math.min(...points.map((p) => p.x));
        const maxX = Math.max(...points.map((p) => p.x));
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
          const defectRate = slice.length > 0 ? slice.reduce((s, p) => s + p.y, 0) / slice.length : 0;
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
        const nullDefectRate =
          nullRows.reduce((s, r) => s + toDefectRate(r), 0) / nullRows.length;
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
    conn = null;
    return NextResponse.json({
      success: true,
      intervals,
      meta: { totalRows: data.length, rowsWithDefectRate: commonData.length },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[defect-by-intervals] error:', msg);
    return NextResponse.json({ success: false, error: msg, intervals: [] }, { status: 500 });
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
