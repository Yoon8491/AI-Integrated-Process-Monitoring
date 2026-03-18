import { NextResponse } from 'next/server';
import {
  getConnection,
  getProcessDataTable,
  getProcessColumnMap,
  getColumns,
  getDashboardDateStrings,
  escapeSqlId,
  isSafeColumnName,
} from '@/lib/dashboard-db';
import { query } from '@/lib/db';
import { getBackendUrl } from '@/lib/backend-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LOTS = 30;

/** lot_data_json에서 LotStatus 형식 추출 */
function lotDataJsonToLotStatus(lotId: string, data: Record<string, unknown> | null): LotStatus {
  if (!data || typeof data !== 'object') {
    return { lotId, passFailResult: null, lithiumInput: null, addictiveRatio: null, processTime: null, humidity: null, tankPressure: null, sinteringTemp: null, recordCount: 0, latestDate: null, params: {} };
  }
  const num = (v: unknown): number | null => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    lotId: String(data.lotId ?? data.lot_id ?? lotId),
    passFailResult: (data.passFailResult ?? data.pass_fail_result ?? null) as string | null,
    lithiumInput: num(data.lithiumInput ?? data.lithium_input),
    addictiveRatio: num(data.addictiveRatio ?? data.addictive_ratio ?? data.additive_ratio),
    processTime: num(data.processTime ?? data.process_time),
    humidity: num(data.humidity),
    tankPressure: num(data.tankPressure ?? data.tank_pressure),
    sinteringTemp: num(data.sinteringTemp ?? data.sintering_temp),
    recordCount: Number(data.recordCount ?? data.record_count ?? 0) || 0,
    latestDate: (data.latestDate ?? data.latest_date ?? null) as string | null,
    params: (typeof data.params === 'object' && data.params != null ? data.params as Record<string, number> : {}),
  };
}

/** 컬럼명에서 온도/습도/압력·공정시간 등 추출용 (공백/언더스코어 무시) */
function pickParam(params: Record<string, number>, ...candidates: string[]): number | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '_');
  for (const cand of candidates) {
    const key = Object.keys(params).find(
      (k) => norm(k) === norm(cand) || norm(k).includes(norm(cand)) || norm(cand).includes(norm(k))
    );
    if (key != null) return params[key];
  }
  // fallback: sintering 관련 컬럼 아무거나
  if (candidates.some((c) => norm(c).includes('sintering'))) {
    const sinteringKey = Object.keys(params).find((k) => norm(k).includes('sintering'));
    if (sinteringKey != null) return params[sinteringKey];
  }
  return null;
}

type LotStatus = {
  lotId: string;
  /** 합불여부: prediction 0=합격, 1=불합격 */
  passFailResult: string | null;
  /** 리튬 투입량 (lithium_input LOT별 평균) */
  lithiumInput: number | null;
  /** 첨가제 비율 (addictive_ratio LOT별 평균) */
  addictiveRatio: number | null;
  /** 공정 시간 (process_time LOT별 평균) */
  processTime: number | null;
  /** 습도 (humidity LOT별 평균) */
  humidity: number | null;
  /** 탱크 압력 (tank_pressure LOT별 평균) */
  tankPressure: number | null;
  /** 소결 온도 (sintering_temp LOT별 평균) */
  sinteringTemp: number | null;
  recordCount: number;
  latestDate: string | null;
  /** 기타 수치 파라미터 (LOT별 평균) */
  params: Record<string, number>;
};

/** period: day=오늘, week=이번 주, month=이번 달. 없으면 기존 365일 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const debug = searchParams.get('debug') === '1';
  const noDateFilter = searchParams.get('noDate') === '1'; // 날짜 조건 제외 시도 (데이터 없을 때 원인 확인)
  const showAll = searchParams.get('all') === '1'; // 합격+불합격 전부 반환 (기본은 불합격만)
  const period = searchParams.get('period') || ''; // 'day' | 'week' | 'month'
  const dateParam = (searchParams.get('date') ?? '').toString().trim();
  const startDateParam = (searchParams.get('startDate') ?? searchParams.get('start') ?? '').toString().trim();
  const endDateParam = (searchParams.get('endDate') ?? searchParams.get('end') ?? '').toString().trim();
  const lotIdSearch = (searchParams.get('lotId') ?? searchParams.get('search') ?? searchParams.get('lot_id') ?? '').toString().trim();

  const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const hasRange = validDate(startDateParam) && validDate(endDateParam);

  // 날짜 범위 선택 시: 백엔드로 프록시해 topImpactParam(불량영향도 색) 포함 응답 받기. 실패 시 DB 직접 조회
  if ((hasRange || (dateParam && validDate(dateParam))) && !lotIdSearch) {
    const [dateFrom, dateTo] = hasRange
      ? [startDateParam, endDateParam].sort()
      : [dateParam, dateParam];
    const proxyParams = new URLSearchParams();
    if (hasRange) {
      proxyParams.set('startDate', dateFrom);
      proxyParams.set('endDate', dateTo);
    } else {
      proxyParams.set('date', dateFrom);
    }
    try {
      const backendUrl = getBackendUrl();
      const proxyUrl = `${backendUrl}/api/dashboard/lot-status?${proxyParams.toString()}`;
      const authHeader = request.headers.get('authorization');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authHeader) headers['Authorization'] = authHeader;
      const proxyRes = await fetch(proxyUrl, { headers, cache: 'no-store' });
      if (proxyRes.ok) {
        const data = await proxyRes.json();
        if (data?.success && Array.isArray(data.lots)) {
          return NextResponse.json(data);
        }
      }
    } catch (e) {
      console.warn('[lot-status] Backend proxy failed, using DB fallback:', e);
    }
    try {
      const rows: any = await query(
        `SELECT lot_id, lot_data_json, DATE_FORMAT(lot_defect_reports.timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp
         FROM lot_defect_reports
         WHERE DATE(lot_defect_reports.timestamp) >= ? AND DATE(lot_defect_reports.timestamp) <= ?
         ORDER BY lot_defect_reports.timestamp DESC, lot_id ASC`,
        [dateFrom, dateTo]
      );
      const lots: LotStatus[] = (rows || []).map((r: { lot_id: string; lot_data_json: string | null; timestamp?: string }) => {
        let data: Record<string, unknown> | null = null;
        if (r.lot_data_json) {
          try {
            data = JSON.parse(r.lot_data_json);
          } catch { /* ignore */ }
        }
        const lot = lotDataJsonToLotStatus(String(r.lot_id ?? ''), data);
        lot.latestDate = r.timestamp ? String(r.timestamp).trim() : lot.latestDate;
        lot.passFailResult = '불합격'; // lot_defect_reports는 불량 LOT만 저장하므로 항상 불합격
        return lot;
      });
      return NextResponse.json({ success: true, lots, totalLots: lots.length, _source: 'lot_defect_reports' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Lot status (lot_defect_reports) API error:', msg);
      return NextResponse.json({ success: false, error: msg, lots: [] }, { status: 500 });
    }
  }

  let conn;
  try {
    conn = await getConnection();
    const tableName = await getProcessDataTable(conn);
    const map = await getProcessColumnMap(conn, tableName);
    const { lotCol, dateCol, resultCol: rawResultCol, defectCol, numericCols } = map;
    // 합불 컬럼: prediction 우선, 없으면 quality_defect/y_defect, 없으면 defect(0/1형, rate 제외) 사용
    const resultCol =
      rawResultCol ||
      (defectCol && !/rate|percent|pct/i.test(defectCol) ? defectCol : null);

    if (!lotCol) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        lots: [],
        message: 'NO_LOT_COLUMN',
        _hint: `테이블 "${tableName}"에서 lot_id/lot/batch 컬럼을 찾지 못함. Vercel 환경변수 DB_NAME=project, DB_HOST 확인.`,
      });
    }

    const selectParts: string[] = [
      `${escapeSqlId(lotCol)} as lot_id`,
      'COUNT(*) as record_count',
    ];
    if (dateCol) selectParts.push(`MAX(${escapeSqlId(dateCol)}) as latest_date`);
    if (resultCol && dateCol) {
      selectParts.push(`SUBSTRING_INDEX(GROUP_CONCAT(CAST(${escapeSqlId(resultCol)} AS CHAR) ORDER BY ${escapeSqlId(dateCol)} DESC), ',', 1) as latest_result`);
    } else if (resultCol) {
      selectParts.push(`MAX(${escapeSqlId(resultCol)}) as latest_result`);
    }

    // LOT별 수치 파라미터 평균 (온도·습도·압력·공정시간 등). process_time 등 알려진 파라미터는 타입 무관 포함
    const excludeFromParams = new Set([lotCol, dateCol, resultCol].filter(Boolean));
    const knownParamNames = [
      'process_time',
      'process time',
      'ProcessTime',
      'processing_time',
      'humidity',
      'tank_pressure',
      'lithium_input',
      'additive_ratio',
      'sintering_temp',
      'sintering temp',
      'sinteringtemp',
      'sintering_temperature',
      'sinteringtemperature',
    ];
    const normCol = (c: string) => c.toLowerCase().replace(/\s+/g, '_');
    const normColNoUnderscore = (c: string) => normCol(c).replace(/_/g, '');
    const allColumns = await getColumns(conn, tableName);
    const numericSet = new Set((numericCols || []).filter((c) => !excludeFromParams.has(c)));
    const extraCols = allColumns
      .map((c) => c.name)
      .filter(
        (name) =>
          !excludeFromParams.has(name) &&
          !numericSet.has(name) &&
          knownParamNames.some(
            (known) =>
              normCol(name) === normCol(known) ||
              normCol(name).includes(normCol(known)) ||
              normCol(known).includes(normCol(name)) ||
              normColNoUnderscore(name) === normColNoUnderscore(known)
          )
      );
    // 따옴표/백틱이 들어간 컬럼명은 동적 SQL에서 제외 (MariaDB 구문 오류 방지)
    let paramCols = [...Array.from(numericSet), ...extraCols].filter(isSafeColumnName);
    // sintering_temp 컬럼이 테이블에 있으면 반드시 포함
    const sinteringCol = allColumns.find(
      (c) =>
        !excludeFromParams.has(c.name) &&
        /sintering/i.test(c.name) &&
        isSafeColumnName(c.name) &&
        !paramCols.includes(c.name)
    )?.name;
    if (sinteringCol) paramCols = [...paramCols, sinteringCol];
    for (const col of paramCols) {
      const alias = col.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^$/, 'p');
      if (numericSet.has(col)) {
        selectParts.push(`AVG(${escapeSqlId(col)}) as ${escapeSqlId('param_' + alias)}`);
      } else {
        selectParts.push(`AVG(CAST(${escapeSqlId(col)} AS DECIMAL(20,6))) as ${escapeSqlId('param_' + alias)}`);
      }
    }

    // 기간 조건: date(달력) 우선, 없으면 day=오늘, week=이번 주, month=이번 달
    const { todayStr, weekStartStr, weekEndStr, firstOfMonth, lastOfMonthStr } = getDashboardDateStrings();

    let dateCondition = '';
    let dateParams: string[] = [];
    // lot_id 검색 시 기간 무시, 전체에서 검색 (LIKE %검색어%), 합격+불합격 전부 표시
    if (lotIdSearch) {
      const lotCondition = `${escapeSqlId(lotCol)} LIKE ?`;
      const lotParam = `%${lotIdSearch.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      dateCondition = `WHERE ${lotCondition}`;
      dateParams = [lotParam];
    } else if (dateCol && !noDateFilter) {
      // 달력에서 선택한 날짜(date 파라미터)가 있으면 해당 날짜로 필터
      if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        dateCondition = `WHERE DATE(${escapeSqlId(dateCol)}) = ?`;
        dateParams = [dateParam];
      } else if (period === 'day') {
        dateCondition = `WHERE DATE(${escapeSqlId(dateCol)}) = ?`;
        dateParams = [todayStr];
      } else if (period === 'week') {
        dateCondition = `WHERE DATE(${escapeSqlId(dateCol)}) >= ? AND DATE(${escapeSqlId(dateCol)}) <= ?`;
        dateParams = [weekStartStr, weekEndStr];
      } else if (period === 'month') {
        dateCondition = `WHERE DATE(${escapeSqlId(dateCol)}) >= ? AND DATE(${escapeSqlId(dateCol)}) <= ?`;
        dateParams = [firstOfMonth, lastOfMonthStr];
      } else {
        dateCondition = `WHERE ${escapeSqlId(dateCol)} >= DATE_SUB(NOW(), INTERVAL 365 DAY)`;
      }
    }
    // 시각(최근 기록) 기준 최근일수록 위에. 날짜 컬럼 없으면 LOT ID 오름차순
    const orderBy = dateCol
      ? 'ORDER BY latest_date DESC, lot_id ASC'
      : 'ORDER BY CAST(lot_id AS UNSIGNED) ASC, lot_id ASC';
    // 불합격(prediction=1) LOT만 조회. debug=1 또는 all=1 또는 lotId 검색 시 HAVING 생략해 합격+불합격 전부 반환
    const havingClause =
      debug || showAll || lotIdSearch || !resultCol
        ? ''
        : `HAVING (CONVERT(latest_result, SIGNED) = 1 OR TRIM(CONVERT(latest_result, CHAR)) = '1')`;

    // 일/주/월 선택 시에는 불합격 LOT 전부 표시, 그 외·debug는 제한
    const limitClause =
      period === 'day' || period === 'week' || period === 'month'
        ? ''
        : `LIMIT ${debug ? 100 : MAX_LOTS}`;

    let dateConditionUsed = dateCondition;
    const mainQuery = `SELECT ${selectParts.join(', ')}
       FROM ${escapeSqlId(tableName)}
       ${dateCondition}
       GROUP BY ${escapeSqlId(lotCol)}
       ${havingClause}
       ${orderBy}
       ${limitClause}`.trim();
    let [rows]: any = dateParams.length > 0
      ? await conn.query(mainQuery, dateParams)
      : await conn.query(mainQuery);

    // 불합격만 조회했는데 0건이면, 기간이 365일일 때만 날짜 조건 제거하고 재시도 (일/주/월 선택 시에는 재시도 안 함)
    if (!debug && resultCol && (!rows || rows.length === 0) && dateCol && period !== 'day' && period !== 'week' && period !== 'month') {
      const noDateCondition = '';
      const [retryRows]: any = await conn.query(
        `SELECT ${selectParts.join(', ')}
         FROM ${escapeSqlId(tableName)}
         ${noDateCondition}
         GROUP BY ${escapeSqlId(lotCol)}
         HAVING (CONVERT(latest_result, SIGNED) = 1 OR TRIM(CONVERT(latest_result, CHAR)) = '1')
         ${orderBy}
         LIMIT ${MAX_LOTS}`
      );
      if (retryRows && retryRows.length > 0) {
        rows = retryRows;
        dateConditionUsed = noDateCondition;
      }
    }

    const lots: LotStatus[] = (rows || []).map((r: Record<string, unknown>) => {
      const params: Record<string, number> = {};
      const rowKeys = Object.keys(r);
      for (const col of paramCols) {
        const paramAlias = col.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^$/, 'p');
        const key = rowKeys.find((k) => k.toLowerCase() === `param_${paramAlias}`.toLowerCase()) ?? `param_${paramAlias}`;
        const val = r[key];
        if (val != null && !Number.isNaN(Number(val))) {
          params[col] = Number(val);
        }
      }

      // prediction: 0=합격, 1=불합격
      let passFailResult: string | null = null;
      if (r.latest_result != null) {
        const v = String(r.latest_result).trim();
        if (v === '0') passFailResult = '합격';
        else if (v === '1') passFailResult = '불합격';
        else passFailResult = v;
      }

      return {
        lotId: String(r.lot_id ?? ''),
        passFailResult,
        lithiumInput: pickParam(params, 'lithium_input'),
        addictiveRatio: pickParam(params, 'addictive_ratio', 'additive_ratio'),
        processTime: pickParam(params, 'process_time', 'process time', 'ProcessTime', 'processing_time', 'processtime'),
        humidity: pickParam(params, 'humidity'),
        tankPressure: pickParam(params, 'tank_pressure'),
        sinteringTemp: pickParam(params, 'sintering_temp', 'sintering temp', 'sinteringtemp', 'sintering_temperature', 'sinteringtemperature'),
        recordCount: Number(r.record_count ?? 0),
        latestDate: r.latest_date != null ? String(r.latest_date) : null,
        params,
      };
    });

    const firstRow = Array.isArray(rows) && rows.length > 0 ? (rows as Record<string, unknown>[])[0] : null;
    const firstRowParamKeys = firstRow
      ? Object.keys(firstRow).filter((k) => k.startsWith('param_'))
      : [];
    const debugInfo =
      debug || process.env.NODE_ENV === 'development' || (rows || []).length === 0
        ? {
            tableName,
            todayStr,
            weekStartStr,
            weekEndStr,
            firstOfMonth,
            lastOfMonthStr,
            lotCol,
            dateCol,
            resultCol,
            hasDateFilter: !!dateCol && !noDateFilter,
            period,
            dateParams,
            totalReturned: (rows || []).length,
            hint: (rows || []).length === 0 ? 'DB 연결·DB_NAME·BACKEND_DATE_TZ=Asia/Seoul·simulation_results 테이블 확인' : undefined,
          }
        : undefined;

    conn.release();
    conn = null;

    // 배포 확인용: Vercel Network 탭 Response에 이 값이 있으면 최신 코드가 적용된 것
    const apiVersion = 'escapeSqlId-2025-02';

    // 불량 LOT 레포트 자동 생성 (비동기, 응답 블로킹 안 함) - MariaDB + ChromaDB에 저장
    const defectiveLots = lots.filter((l) => l.passFailResult === '불합격');
    // 불량 LOT 레포트 생성은 백엔드 API로 전환됨 (프론트엔드에서는 제거)

    return NextResponse.json({
      success: true,
      lots,
      totalLots: lots.length,
      _apiVersion: apiVersion,
      _debug: debugInfo,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Lot status API error:', msg);
    return NextResponse.json(
      {
        success: false,
        error: msg,
        lots: [],
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
