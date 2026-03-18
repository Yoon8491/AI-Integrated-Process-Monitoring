import type { FastifyInstance } from 'fastify';
import { getConnection, getProcessDataTable, getProcessColumnMap, getColumns, getDashboardDateStrings, escapeSqlId, isSafeColumnName } from '../../lib/dashboard-db.js';
import { requireAuth } from '../../middlewares/auth.js';
import { authQuery } from '../../db.js';
import { calculateNormalRanges, getTopImpactParamForLot, loadModelFeatureImportance } from './lot-defect-report.js';

const MAX_LOTS = 30;

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
  passFailResult: string | null;
  lithiumInput: number | null;
  addictiveRatio: number | null;
  processTime: number | null;
  humidity: number | null;
  tankPressure: number | null;
  sinteringTemp: number | null;
  recordCount: number;
  latestDate: string | null;
  params: Record<string, number>;
};

export async function registerDashboardLotStatus(app: FastifyInstance) {
  app.get('/api/dashboard/lot-status', async (request, reply) => {
    const user = await requireAuth(request as any);
    if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized', lots: [] });

    const q = (request.query || {}) as any;
    const debug = String(q.debug) === '1';
    const noDateFilter = String(q.noDate) === '1';
    const showAll = String(q.all) === '1';
    const period = q.period ? String(q.period) : '';
    const dateParam = (q.date ?? '').toString().trim(); // YYYY-MM-DD, 단일 날짜
    const startDateParam = (q.startDate ?? q.start ?? '').toString().trim();
    const endDateParam = (q.endDate ?? q.end ?? '').toString().trim();
    const lotIdSearch = (q.lotId ?? q.search ?? q.lot_id ?? '').toString().trim();

    const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const hasRange = validDate(startDateParam) && validDate(endDateParam);

    // 달력 날짜 범위 선택 시: lot_defect_reports에서 해당 기간 레포트 조회
    if ((hasRange || (dateParam && validDate(dateParam))) && !lotIdSearch) {
      try {
        const [dateFrom, dateTo] = hasRange
          ? [startDateParam, endDateParam].sort()
          : [dateParam, dateParam];
        const rows: any = await authQuery(
          `SELECT lot_id, lot_data_json, timestamp
           FROM lot_defect_reports
           WHERE DATE(timestamp) >= ? AND DATE(timestamp) <= ?
           ORDER BY timestamp DESC, lot_id ASC`,
          [dateFrom, dateTo]
        );
        const lotsFromReports = (rows || []).map((r: { lot_id: string; lot_data_json: string | null; timestamp: string }) => {
          let data: Record<string, unknown> | null = null;
          if (r.lot_data_json) {
            try {
              data = JSON.parse(r.lot_data_json);
            } catch { /* ignore */ }
          }
          const lot = lotDataJsonToLotStatus(String(r.lot_id ?? ''), data);
          lot.latestDate = r.timestamp ? String(r.timestamp).slice(0, 19) : lot.latestDate;
          lot.passFailResult = '불합격'; // lot_defect_reports는 불량 LOT만 저장하므로 항상 불합격
          return lot;
        });
        let lotsWithImpact = lotsFromReports;
        try {
          const paramNames = ['lithiumInput', 'addictiveRatio', 'processTime', 'humidity', 'tankPressure', 'sinteringTemp'];
          const normalRanges = await calculateNormalRanges(paramNames, 'ko');
          const modelImportance = loadModelFeatureImportance();
          if (Object.keys(normalRanges).length > 0) {
            lotsWithImpact = lotsFromReports.map((lot) => {
              const topImpact = getTopImpactParamForLot(lot, normalRanges, modelImportance);
              return { ...lot, topImpactParam: topImpact };
            });
          }
        } catch (e) {
          request.log.warn({ err: e }, '[lot-status] topImpactParam 계산 스킵 (lot_defect_reports)');
        }
        return reply.send({ success: true, lots: lotsWithImpact, totalLots: lotsWithImpact.length, _source: 'lot_defect_reports' });
      } catch (e) {
        console.error('[lot-status] lot_defect_reports 조회 오류:', e);
        return reply.code(500).send({ success: false, error: String(e), lots: [] });
      }
    }

    let conn: any;
    try {
      conn = await getConnection();
      const tableName = await getProcessDataTable(conn);
      const map = await getProcessColumnMap(conn, tableName);
      const { lotCol, dateCol, resultCol: rawResultCol, defectCol, numericCols } = map;
      const resultCol =
        rawResultCol || (defectCol && !/rate|percent|pct/i.test(defectCol) ? defectCol : null);

      if (!lotCol) {
        conn.release();
        return reply.send({ success: true, lots: [], message: 'NO_LOT_COLUMN' });
      }

      const selectParts: string[] = [`${escapeSqlId(lotCol)} as lot_id`, 'COUNT(*) as record_count'];
      if (dateCol) selectParts.push(`MAX(${escapeSqlId(dateCol)}) as latest_date`);
      if (resultCol && dateCol) {
        selectParts.push(
          `SUBSTRING_INDEX(GROUP_CONCAT(CAST(${escapeSqlId(resultCol)} AS CHAR) ORDER BY ${escapeSqlId(dateCol)} DESC), ',', 1) as latest_result`
        );
      } else if (resultCol) {
        selectParts.push(`MAX(${escapeSqlId(resultCol)}) as latest_result`);
      }

      const excludeFromParams = new Set([lotCol, dateCol, resultCol].filter(Boolean) as string[]);
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

      const orderBy = 'ORDER BY CAST(lot_id AS UNSIGNED) ASC, lot_id ASC';
      const havingClause =
        debug || showAll || lotIdSearch || !resultCol
          ? ''
          : `HAVING (CONVERT(latest_result, SIGNED) = 1 OR TRIM(CONVERT(latest_result, CHAR)) = '1')`;
      const limitClause =
        period === 'day' || period === 'week' || period === 'month' || (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam))
          ? ''
          : `LIMIT ${debug ? 100 : MAX_LOTS}`;

      const mainQuery = `SELECT ${selectParts.join(', ')}
       FROM ${escapeSqlId(tableName)}
       ${dateCondition}
       GROUP BY ${escapeSqlId(lotCol)}
       ${havingClause}
       ${orderBy}
       ${limitClause}`.trim();
      const [rows]: any = dateParams.length > 0 ? await conn.query(mainQuery, dateParams) : await conn.query(mainQuery);

      const lots: LotStatus[] = (rows || []).map((r: any) => {
        const params: Record<string, number> = {};
        const rowKeys = Object.keys(r);
        for (const col of paramCols) {
          const paramAlias = col.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^$/, 'p');
          const alias = `param_${paramAlias}`;
          const key = rowKeys.find((k) => k.toLowerCase() === alias.toLowerCase()) ?? alias;
          const val = r[key];
          if (val != null && !Number.isNaN(Number(val))) {
            params[col] = Number(val);
          }
        }

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

      // LOT별 리포트 불량영향도 Top 1 파라미터 계산 (테이블 음영용)
      let lotsWithImpact: (LotStatus & { topImpactParam?: string | null })[] = lots;
      try {
        const paramNames = ['lithiumInput', 'addictiveRatio', 'processTime', 'humidity', 'tankPressure', 'sinteringTemp'];
        const normalRanges = await calculateNormalRanges(paramNames, 'ko');
        const modelImportance = loadModelFeatureImportance();
        if (Object.keys(normalRanges).length > 0) {
          lotsWithImpact = lots.map((lot) => {
            const topImpact = getTopImpactParamForLot(lot, normalRanges, modelImportance);
            return { ...lot, topImpactParam: topImpact };
          });
        }
      } catch (e) {
        request.log.warn({ err: e }, '[lot-status] topImpactParam 계산 스킵');
      }

      conn.release();
      return reply.send({ success: true, lots: lotsWithImpact, totalLots: lotsWithImpact.length });
    } catch (e: unknown) {
      const err = e as { sql?: string; sqlMessage?: string; code?: string };
      console.error('[dashboard/lot-status] DB error:', e);
      if (err?.sql) console.error('[dashboard/lot-status] SQL:', err.sql);
      if (err?.sqlMessage) console.error('[dashboard/lot-status] sqlMessage:', err.sqlMessage);
      const msg = e instanceof Error ? e.message : String(e);
      request.log.error({ err: e }, 'Lot status API error');
      if (conn) try { conn.release(); } catch {}
      return reply.code(500).send({ success: false, error: msg, lots: [] });
    }
  });
}

