import { NextResponse } from 'next/server';
import {
  getConnection,
  getProcessDataTable,
  getColumns,
  getTables,
} from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RECENT_LIMIT = 50; // 최근 N개 데이터로 추세 계산

type SensorData = {
  name: string;
  nameKorean: string;
  currentValue: number;
  previousValue: number;
  trend: 'up' | 'down' | 'stable'; // 추세
  changePercent: number;
  unit: string;
};

/** 센서 컬럼 감지 */
function isSensorColumn(col: string): boolean {
  const sensorKeywords = [
    'temperature', 'temp', 'humidity', 'pressure', 'voltage', 'current',
    'power', 'energy', 'speed', 'flow', 'level', 'rpm', 'vibration',
    '온도', '습도', '압력', '전압', '전류', '전력'
  ];
  const lower = col.toLowerCase();
  return sensorKeywords.some((k) => lower.includes(k));
}

/** 컬럼명 → 한국어 + 단위 */
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

export async function GET(request: Request) {
  let conn;
  try {
    const { searchParams } = new URL(request.url);
    const includeHistory = searchParams.get('history') === 'true';
    const historyPeriod = searchParams.get('period') || 'recent'; // 'recent'(50개) | 'day'(당일 전체)
    const historyDate = searchParams.get('date'); // 'YYYY-MM-DD' 특정 날짜
    const iqrFromAll = searchParams.get('iqr') === 'all'; // IQR은 raw_data 전체로 계산
    
    conn = await getConnection();
    const tableName = await getProcessDataTable(conn);
    if (!tableName) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        sensors: [],
        history: [],
        message: 'NO_TABLE',
      });
    }

    const columns = await getColumns(conn, tableName);
    const allColNames = columns.map((c) => c.name);
    const numericCols = columns
      .filter((c) => /int|decimal|float|double/i.test(c.type))
      .map((c) => c.name);

    // 센서 컬럼만 필터링
    const sensorCols = numericCols.filter(isSensorColumn);

    if (sensorCols.length === 0) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        sensors: [],
        message: 'NO_SENSOR_COLUMNS',
      });
    }

    // 날짜 컬럼 찾기
    const dateCol = columns.find((c) =>
      /date|time|created|recorded/i.test(c.name) || /date|time/i.test(c.type)
    )?.name;

    const orderBy = dateCol ? `ORDER BY \`${dateCol}\` DESC` : '';
    const colList = sensorCols.map((c) => `\`${c}\``).join(', ');

    // 최근 데이터 조회
    const [rows]: any = await conn.query(
      `SELECT ${colList} FROM \`${tableName}\` ${orderBy} LIMIT ${RECENT_LIMIT}`
    );

    if (!rows || rows.length < 2) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        sensors: [],
        message: 'INSUFFICIENT_DATA',
      });
    }

    const sensors: SensorData[] = [];

    // 각 센서별 현재값, 이전값, 추세 계산
    for (const col of sensorCols) {
      const values = rows
        .map((r) => r[col])
        .filter((v) => v != null && !Number.isNaN(Number(v)))
        .map((v) => Number(v));

      if (values.length < 2) continue;

      const currentValue = values[0];
      const previousValue = values[1];
      const avgPrevious = values.slice(1, 6).reduce((a, b) => a + b, 0) / Math.min(5, values.length - 1);

      // 추세 계산 (현재값 vs 최근 5개 평균)
      const changePercent = avgPrevious !== 0 ? ((currentValue - avgPrevious) / avgPrevious) * 100 : 0;
      let trend: 'up' | 'down' | 'stable' = 'stable';
      if (Math.abs(changePercent) > 2) {
        trend = changePercent > 0 ? 'up' : 'down';
      }

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

    // 추이 차트용 히스토리: raw_data / simulation_results 별도 테이블이 있으면 두 테이블 조인
    let history: { time: string; [key: string]: string | number | Record<string, unknown> }[] = [];
    let rawDataForIqr: Record<string, number[]> | null = null;
    if (includeHistory) {
      const tables = await getTables(conn);
      const tableNamesLower = tables.map((t) => t.toLowerCase());
      let hasRawData = tableNamesLower.includes('raw_data');
      let hasSimulationResults = tableNamesLower.includes('simulation_results');
      let hasPreprocessing = tableNamesLower.includes('preprocessing');
      const comparisonDb = process.env.COMPARISON_DB_NAME?.trim(); // 비교용 테이블이 있는 DB (예: project)
      const dbPrefix = comparisonDb ? `\`${comparisonDb}\`.` : '';

      if (!hasRawData && comparisonDb) {
        try {
          const [r] = await conn.query<any[]>(`SELECT 1 FROM ${dbPrefix}\`raw_data\` LIMIT 1`);
          hasRawData = Array.isArray(r) && r.length > 0;
        } catch {
          /* ignore */
        }
      }
      if (!hasSimulationResults && comparisonDb) {
        try {
          const [r] = await conn.query<any[]>(`SELECT 1 FROM ${dbPrefix}\`simulation_results\` LIMIT 1`);
          hasSimulationResults = Array.isArray(r) && r.length > 0;
        } catch {
          /* ignore */
        }
      }
      if (!hasPreprocessing && comparisonDb) {
        try {
          const [r] = await conn.query<any[]>(`SELECT 1 FROM ${dbPrefix}\`preprocessing\` LIMIT 1`);
          hasPreprocessing = Array.isArray(r) && r.length > 0;
        } catch {
          /* ignore */
        }
      }

      // IQR용: data_sample 테이블 전체 값 조회 (날짜 무관)
      const iqrTableName = (process.env.COMPARISON_TABLE_NAME || 'data_sample').trim();
      const hasDataSample = tableNamesLower.includes(iqrTableName.toLowerCase());
      if (iqrFromAll && hasDataSample) {
        try {
          const iqrTable = dbPrefix ? `${dbPrefix}\`${iqrTableName}\`` : `\`${iqrTableName}\``;
          const dsCols = await getColumns(conn, iqrTableName);
          const num = (c: { type: string }) => /int|decimal|float|double|bigint/i.test(c.type);
          const metricsIqr = dsCols.filter(num).map((c) => c.name);
          if (metricsIqr.length > 0) {
            const sel = metricsIqr.map((c) => `\`${c}\``).join(', ');
            const [iqrRows] = await conn.query<any[]>(
              `SELECT ${sel} FROM ${iqrTable}`
            );
            const arr = Array.isArray(iqrRows) ? iqrRows : [];
            rawDataForIqr = {} as Record<string, number[]>;
            for (const m of metricsIqr) (rawDataForIqr as Record<string, number[]>)[m] = [];
            for (const row of arr) {
              for (const m of metricsIqr) {
                const v = Number(row[m] ?? 0);
                if (Number.isFinite(v)) (rawDataForIqr as Record<string, number[]>)[m].push(v);
              }
            }
          }
        } catch (err) {
          console.error('data_sample IQR query error:', err);
        }
      }

      const dateParam = historyDate && /^\d{4}-\d{2}-\d{2}$/.test(historyDate) ? historyDate : null;
      const useDayFilter = historyPeriod === 'day' || !!dateParam;

      if ((hasRawData && hasSimulationResults) || (hasSimulationResults && hasPreprocessing)) {
        const rdTable = dbPrefix ? `${dbPrefix}\`raw_data\`` : '`raw_data`';
        const srTable = dbPrefix ? `${dbPrefix}\`simulation_results\`` : '`simulation_results`';
        const prepTable = dbPrefix ? `${dbPrefix}\`preprocessing\`` : '`preprocessing`';
        let metrics = ['humidity', 'tank_pressure', 'sintering_temp'];
        let tsCol = 'timestamp';
        let isTextTs = true;

        if (!dbPrefix) {
          const rdCols = hasRawData ? await getColumns(conn, 'raw_data') : [];
          const srCols = await getColumns(conn, 'simulation_results');
          const prepCols = hasPreprocessing ? await getColumns(conn, 'preprocessing') : [];
          const num = (c: { type: string }) => /int|decimal|float|double|bigint/i.test(c.type);
          const srNumNames = new Set(srCols.filter(num).map((c) => c.name));
          const prepNumNames = prepCols.length ? new Set(prepCols.filter(num).map((c) => c.name)) : srNumNames;
          const common = [...srNumNames].filter((m) => prepNumNames.has(m) || prepNumNames.size === 0);
          metrics = ['humidity', 'tank_pressure', 'sintering_temp'].filter((m) => common.includes(m) || srNumNames.has(m));
          if (metrics.length === 0) metrics = [...srNumNames].slice(0, 5);
          const refCols = rdCols.length ? rdCols : srCols;
          tsCol = refCols.find((c) => /timestamp|date|time/i.test(c.name))?.name || 'timestamp';
          const tsType = refCols.find((c) => c.name === tsCol)?.type ?? '';
          isTextTs = /text|char|varchar/i.test(tsType);
        }

        if (metrics.length > 0 && useDayFilter && dateParam) {
          const sel = [tsCol, ...metrics].map((c) => `\`${c}\``).join(', ');
          const dateCond = isTextTs ? `\`${tsCol}\` LIKE ?` : `DATE(\`${tsCol}\`) = ?`;
          const dateArg = isTextTs ? `${dateParam}%` : dateParam;

          try {
            const [srRows] = await conn.query<any[]>(
              `SELECT ${sel} FROM ${srTable} WHERE ${dateCond} ORDER BY \`${tsCol}\` ASC LIMIT 5000`,
              [dateArg]
            );
            const sr = Array.isArray(srRows) ? srRows : [];

            let rd: any[] = [];
            if (hasRawData) {
              const [rdRows] = await conn.query<any[]>(
                `SELECT ${sel} FROM ${rdTable} WHERE ${dateCond} ORDER BY \`${tsCol}\` ASC LIMIT 5000`,
                [dateArg]
              );
              rd = Array.isArray(rdRows) ? rdRows : [];
            }

            let prep: any[] = [];
            if (hasPreprocessing) {
              const [prepRows] = await conn.query<any[]>(
                `SELECT ${sel} FROM ${prepTable} WHERE ${dateCond} ORDER BY \`${tsCol}\` ASC LIMIT 5000`,
                [dateArg]
              );
              prep = Array.isArray(prepRows) ? prepRows : [];
            }

            /** 날짜+시+분 키 (초 제외). "YYYY-MM-DD HH:mm" */
            const toDateMinuteKey = (row: any): string => {
              const t = row?.[tsCol];
              const d = t instanceof Date ? t : new Date(t ?? 0);
              if (Number.isNaN(d.getTime())) return '';
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              const h = String(d.getHours()).padStart(2, '0');
              const min = String(d.getMinutes()).padStart(2, '0');
              return `${y}-${m}-${day} ${h}:${min}`;
            };

            const rdByKey = new Map<string, any>();
            for (const row of rd) {
              const key = toDateMinuteKey(row);
              if (key && !rdByKey.has(key)) rdByKey.set(key, row);
            }
            const srByKey = new Map<string, any>();
            for (const row of sr) {
              const key = toDateMinuteKey(row);
              if (key && !srByKey.has(key)) srByKey.set(key, row);
            }
            const prepByKey = new Map<string, any>();
            for (const row of prep) {
              const key = toDateMinuteKey(row);
              if (key && !prepByKey.has(key)) prepByKey.set(key, row);
            }

            const baseKeys = hasPreprocessing
              ? [...srByKey.keys()].filter((k) => prepByKey.has(k))
              : [...srByKey.keys()];
            const commonKeys = hasRawData
              ? baseKeys.filter((k) => rdByKey.has(k)).sort()
              : [...new Set([...baseKeys, ...prepByKey.keys()])].filter((k) => srByKey.has(k)).sort();

            history = commonKeys.map((key) => {
              const rdRow = rdByKey.get(key);
              const srRow = srByKey.get(key)!;
              const prepRow = prepByKey.get(key);
              const t = (prepRow || srRow || rdRow)?.[tsCol];
              const timeStr = t instanceof Date ? t.toISOString() : String(t ?? key);
              const raw_data: Record<string, number> = {};
              const simulation_results: Record<string, number> = {};
              const preprocessing: Record<string, number> = {};
              for (const m of metrics) {
                if (rdRow) raw_data[m] = Number(rdRow[m] ?? 0);
                simulation_results[m] = Number(srRow[m] ?? 0);
                if (prepRow) preprocessing[m] = Number(prepRow[m] ?? 0);
              }
              const out: { time: string; raw_data?: Record<string, number>; simulation_results: Record<string, number>; preprocessing?: Record<string, number> } = {
                time: timeStr,
                simulation_results,
              };
              if (Object.keys(raw_data).length > 0) out.raw_data = raw_data;
              if (Object.keys(preprocessing).length > 0) out.preprocessing = preprocessing;
              return out;
            });

            if (history.length > 0) {
              sensors.length = 0;
              const firstRow = history[0] as { raw_data?: Record<string, number>; preprocessing?: Record<string, number>; simulation_results: Record<string, number> };
              const secondRow = history[1] as typeof firstRow | undefined;
              for (const m of metrics) {
                const displayName = m === 'sintering_temp' ? '온도' : getSensorInfo(m).korean;
                const unit = m === 'sintering_temp' ? '°C' : getSensorInfo(m).unit;
                const v0 = firstRow?.preprocessing?.[m] ?? firstRow?.simulation_results?.[m] ?? firstRow?.raw_data?.[m] ?? 0;
                const v1 = secondRow?.preprocessing?.[m] ?? secondRow?.simulation_results?.[m] ?? secondRow?.raw_data?.[m] ?? v0;
                sensors.push({
                  name: m,
                  nameKorean: displayName,
                  currentValue: Number(v0),
                  previousValue: Number(v1),
                  trend: 'stable',
                  changePercent: 0,
                  unit,
                });
              }
            }
          } catch (err) {
            console.error('raw_data/simulation_results history query error:', err);
          }
        }
      }

      if (history.length === 0 && dateCol) {
        const historyCols = [...sensorCols];
        for (const baseCol of sensorCols) {
          if (numericCols.includes(`${baseCol}_simulation`) && !historyCols.includes(`${baseCol}_simulation`)) {
            historyCols.push(`${baseCol}_simulation`);
          }
          if (numericCols.includes(`${baseCol}_sample`) && !historyCols.includes(`${baseCol}_sample`)) {
            historyCols.push(`${baseCol}_sample`);
          }
        }
        if (allColNames.includes('raw_data') && !historyCols.includes('raw_data')) {
          historyCols.push('raw_data');
        }
        if (allColNames.includes('simulation_results') && !historyCols.includes('simulation_results')) {
          historyCols.push('simulation_results');
        }
        if (numericCols.includes('anomaly_depth') && !historyCols.includes('anomaly_depth')) {
          historyCols.push('anomaly_depth');
        }
        const historyColList = historyCols.map((c) => `\`${c}\``).join(', ');
        const dayWhere =
          historyDate && /^\d{4}-\d{2}-\d{2}$/.test(historyDate)
            ? ` WHERE DATE(\`${dateCol}\`) = ?`
            : historyPeriod === 'day'
              ? ` WHERE DATE(\`${dateCol}\`) = CURDATE()`
              : '';
        const dayParams = historyDate && /^\d{4}-\d{2}-\d{2}$/.test(historyDate) ? [historyDate] : [];
        const useDayFilter2 = historyPeriod === 'day' || (historyDate && /^\d{4}-\d{2}-\d{2}$/.test(historyDate));
        const historyOrder = useDayFilter2 ? ` ORDER BY \`${dateCol}\` ASC` : ` ORDER BY \`${dateCol}\` DESC LIMIT 50`;
        const dayLimit = useDayFilter2 ? ' LIMIT 5000' : '';
        const [historyRows] = dayParams.length > 0
          ? await conn.query(
              `SELECT \`${dateCol}\` as time, ${historyColList}
               FROM \`${tableName}\`${dayWhere}${historyOrder}${dayLimit}`,
              dayParams
            )
          : await conn.query(
              `SELECT \`${dateCol}\` as time, ${historyColList}
               FROM \`${tableName}\`${dayWhere}${historyOrder}${dayLimit}`
            );

        const jsonCols = ['raw_data', 'simulation_results', 'preprocessing'];
        let rawRows = (historyRows || []).map((r: any) => {
          const timeVal = r.time;
          const timeStr = timeVal instanceof Date ? timeVal.toISOString() : String(timeVal ?? '');
          const row: { time: string; [key: string]: string | number | Record<string, unknown> } = { time: timeStr };
          for (const col of historyCols) {
            const val = r[col];
            if (jsonCols.includes(col)) {
              if (val == null) row[col] = {};
              else if (typeof val === 'object' && !Array.isArray(val)) row[col] = val as Record<string, unknown>;
              else if (typeof val === 'string') {
                try {
                  row[col] = (JSON.parse(val) as Record<string, unknown>) || {};
                } catch {
                  row[col] = {};
                }
              } else row[col] = {};
            } else {
              row[col] = Number(val ?? 0);
            }
          }
          return row;
        });
        history = useDayFilter2 ? rawRows : rawRows.reverse();
      }
    }

    conn.release();
    conn = null;

    return NextResponse.json({
      success: true,
      sensors,
      history,
      rawDataForIqr: rawDataForIqr ?? undefined,
      totalSensors: sensors.length,
      dataPoints: rows.length,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Realtime API error:', msg);
    return NextResponse.json(
      {
        success: false,
        error: msg,
        sensors: [],
      },
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
