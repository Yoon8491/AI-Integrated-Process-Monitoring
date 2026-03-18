import { NextRequest, NextResponse } from 'next/server';
import {
  getConnection,
  getProcessDataTable,
  getProcessColumnMap,
  getColumns,
  escapeSqlId,
  isSafeColumnName,
} from '@/lib/dashboard-db';
import {
  matchColumns,
  extractNumber,
  isLotQuery,
  columnToKorean,
  describeColumns,
} from '@/lib/column-matcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Period = 'day' | 'week' | 'month';

/** 사용자 질문에서 기간 추론 (기본: week) */
function inferPeriod(q: string): Period {
  const s = (q || '').toLowerCase().replace(/\s/g, '');
  if (/\b(오늘|금일|today)\b/.test(s)) return 'day';
  if (
    /\b(최근\s*한\s*달|최근\s*한달|지난\s*30일|최근\s*30일|최근\s*1개월|지난\s*1개월|월간|한달|last\s*30|past\s*month|last\s*month)\b/i.test(q) ||
    /한\s*달|한달|1개월|30일/.test(s)
  )
    return 'month';
  if (
    /\b(최근\s*일주일|최근\s*1주|지난\s*7일|최근\s*7일|지난\s*1주|주간|일주일|last\s*7|past\s*week|last\s*week)\b/i.test(q) ||
    /일주일|7일|1주|주간/.test(s)
  )
    return 'week';
  return 'week';
}

/** 특정 변수/컬럼에 대한 질의인지 확인 */
function isSpecificColumnQuery(q: string): boolean {
  const s = (q || '').toLowerCase();
  // "~은?", "~는?", "~이?", "~가?", "얼마", "몇", "알려줘", "보여줘", "데이터", "값"
  return /투입|소비|온도|압력|습도|농도|속도|무게|두께|전압|전류|input|output|rate|temp|pressure/.test(s) ||
    /(\w+)\s*(은|는|이|가)\s*(\?|얼마|몇)/.test(s) ||
    /알려|보여|데이터|값|수치/.test(s);
}

/** 품질/불량 관련 의도 여부 */
function wantsQuality(q: string): boolean {
  const s = (q || '').toLowerCase();
  return /불량|품질|합격|defect|quality|pass\s*rate|불량품|합격률|불량률/.test(s);
}

/** 생산 관련 의도 여부 */
function wantsProduction(q: string): boolean {
  const s = (q || '').toLowerCase();
  return /생산|생산량|production|quantity|생산현황|출고/.test(s);
}

/** 에너지 관련 의도 여부 */
function wantsEnergy(q: string): boolean {
  const s = (q || '').toLowerCase();
  return /에너지|energy|소비|consumption|전력|kwh/.test(s);
}

/** 공정별 전력/에너지 질문 여부 (에너지 시각 분석 대시보드 테이블 기준) */
function wantsProcessEnergy(q: string): boolean {
  const s = (q || '').toLowerCase();
  return /코팅|혼합|건조|소성|분쇄|공정별\s*전력|공정별\s*에너지|공정\s*전력/.test(s);
}

/** 에너지 시각 분석 페이지 "공정별 에너지 등급 및 효율 상세" 테이블과 동일한 mock 데이터 */
const PROCESS_ENERGY_TABLE = [
  { processKo: '혼합', processEn: 'Mixing', energyGrade: 'A', powerConsumptionKwh: 1250, productionCurrent: 850, productionTarget: 1000, energyPerUnit: 1.47, carbonEmission: 0.6 },
  { processKo: '코팅', processEn: 'Coating', energyGrade: 'B', powerConsumptionKwh: 2100, productionCurrent: 720, productionTarget: 800, energyPerUnit: 2.92, carbonEmission: 1.1 },
  { processKo: '건조', processEn: 'Drying', energyGrade: 'A', powerConsumptionKwh: 1800, productionCurrent: 680, productionTarget: 750, energyPerUnit: 2.65, carbonEmission: 0.9 },
  { processKo: '소성', processEn: 'Sintering', energyGrade: 'C', powerConsumptionKwh: 3500, productionCurrent: 520, productionTarget: 600, energyPerUnit: 6.73, carbonEmission: 1.8 },
  { processKo: '분쇄', processEn: 'Grinding', energyGrade: 'B', powerConsumptionKwh: 1650, productionCurrent: 780, productionTarget: 900, energyPerUnit: 2.12, carbonEmission: 0.8 },
];

/** 효율 관련 의도 여부 */
function wantsEfficiency(q: string): boolean {
  const s = (q || '').toLowerCase();
  return /효율|efficiency|가동률|설비|oee|uptime/.test(s);
}

/** 대시보드/공정 현황 등 일반 문의 → 품질+생산 최소 포함 */
function wantsAnyDashboard(q: string): boolean {
  const s = (q || '').toLowerCase();
  return (
    /현황|알려|알려줘|보여|몇\s*개|얼마|대시보드|공정\s*데이터|factory|공정\s*현황|지표|데이터/.test(s) &&
    !wantsQuality(s) &&
    !wantsProduction(s) &&
    !wantsEnergy(s) &&
    !wantsEfficiency(s)
  );
}

/** FDC 알림/경고 관련 의도 */
function wantsAlerts(q: string): boolean {
  const s = (q || '').toLowerCase();
  return /경고|알람|알림|이상|fdc|관리선|이탈|anomaly|alert/.test(s);
}

/** 최근/마지막/방금 + 불량 LOT 질의인지 (자동으로 최신 불합격 LOT 조회 트리거) */
function isRecentDefectLotQuery(q: string): boolean {
  const s = (q || '').trim();
  const hasRecent = /최근|마지막|방금|최신|last|recent|latest/.test(s);
  const hasDefectLot = /불량\s*LOT|불량\s*롯|LOT\s*불량|최근\s*불량|불량\s*내역|defect\s*lot|recent\s*defect/.test(s);
  return !!(hasRecent && hasDefectLot);
}

/** DB에서 합격 여부가 불합격인 가장 최신 LOT ID 1건 조회 */
async function fetchLatestDefectLotId(): Promise<{ lotId: string | null; error?: string }> {
  let conn;
  try {
    conn = await getConnection();
    const tableName = await getProcessDataTable(conn);
    if (!tableName) return { lotId: null };
    const map = await getProcessColumnMap(conn, tableName);
    const { lotCol, dateCol, resultCol } = map;
    if (!lotCol || !resultCol || !isSafeColumnName(lotCol) || !isSafeColumnName(resultCol)) return { lotId: null };
    const orderCol = dateCol && isSafeColumnName(dateCol) ? dateCol : null;
    if (!orderCol) return { lotId: null };
    const failCondition = `(TRIM(CAST(${escapeSqlId(resultCol)} AS CHAR)) IN ('1', '불합격', 'fail', 'NG') OR CAST(${escapeSqlId(resultCol)} AS DECIMAL(10,4)) = 1)`;
    const [rows]: any = await conn.query(
      `SELECT ${escapeSqlId(lotCol)} as lot_id FROM ${escapeSqlId(tableName)} WHERE ${failCondition} ORDER BY ${escapeSqlId(orderCol)} DESC LIMIT 1`
    );
    conn.release();
    conn = null;
    const id = rows?.[0]?.lot_id;
    return { lotId: id != null ? String(id).trim() : null };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    if (conn) try { conn.release(); } catch { /* ignore */ }
    return { lotId: null, error: err };
  }
}

/** 실시간 센서(습도·압력 등) 관련 의도 */
function wantsRealtime(q: string): boolean {
  const s = (q || '').toLowerCase();
  return /실시간|현재\s*습도|현재\s*압력|습도\s*얼마|압력\s*얼마|센서|humidity|pressure|tank/.test(s);
}

/** 질문에서 특정 날짜 추출 (예: 2026-2-4, 2026.2.4, 2026년 2월 4일, 2월 4일) → 캘린더와 동일한 데이터 제공용 */
function parseRequestedDate(q: string): { year: number; month: number; day: number } | null {
  const s = (q || '').trim();
  // 2026-2-4, 2026-02-04, 2026/2/4
  const dashSlash = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (dashSlash) {
    return { year: parseInt(dashSlash[1], 10), month: parseInt(dashSlash[2], 10), day: parseInt(dashSlash[3], 10) };
  }
  // 2026.2.4
  const dot = s.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (dot) {
    return { year: parseInt(dot[1], 10), month: parseInt(dot[2], 10), day: parseInt(dot[3], 10) };
  }
  // 2026년 2월 4일, 2026년 2월 4
  const krFull = s.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일?/);
  if (krFull) {
    return { year: parseInt(krFull[1], 10), month: parseInt(krFull[2], 10), day: parseInt(krFull[3], 10) };
  }
  // 2월 4일, 2월 4 (올해로 가정)
  const krNoYear = s.match(/(\d{1,2})월\s*(\d{1,2})일?/);
  if (krNoYear) {
    const y = new Date().getFullYear();
    return { year: y, month: parseInt(krNoYear[1], 10), day: parseInt(krNoYear[2], 10) };
  }
  return null;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';

  let recentDefectLotId: string | null = null;
  let recentDefectLotNoData = false;
  let recentDefectLotMessage: string | undefined;
  if (isRecentDefectLotQuery(q)) {
    const { lotId, error } = await fetchLatestDefectLotId();
    if (error) console.warn('[Chat-context] fetchLatestDefectLotId error:', error);
    if (lotId) {
      recentDefectLotId = lotId;
      recentDefectLotMessage = `가장 최근 발생한 ${lotId}의 분석 결과를 바탕으로 답하세요. 답변 시 '가장 최근 발생한 ${lotId}의 분석 결과입니다'라고 안내하세요.`;
    } else {
      recentDefectLotNoData = true;
      recentDefectLotMessage = '최근 발생한 불량 LOT 내역이 없습니다. 사용자에게 이 문구를 그대로 전달하세요.';
    }
  }

  const period = inferPeriod(q);
  const fetchQuality = wantsQuality(q) || wantsAnyDashboard(q);
  const fetchProduction = wantsProduction(q) || wantsAnyDashboard(q);
  const fetchEnergy = wantsEnergy(q);
  const fetchEfficiency = wantsEfficiency(q);
  const fetchAlerts = wantsAlerts(q) || wantsAnyDashboard(q);
  const fetchRealtime = wantsRealtime(q) || wantsAnyDashboard(q);

  const base = request.nextUrl.origin;

  type Summary = { data?: Record<string, unknown>; fromDb?: boolean };
  type Detail = { success?: boolean; period?: string; data?: unknown[]; byLine?: unknown[] };
  type AlertItem = { column: string; columnKorean: string; currentValue: number; mean: number; upperLimit: number; lowerLimit: number; deviation: number; severity: string };
  type SensorItem = { name: string; nameKorean: string; currentValue: number; unit: string };

  let summary: Summary = {};
  let quality: Detail | null = null;
  let production: Detail | null = null;
  let energy: Detail | null = null;
  let efficiency: Detail | null = null;
  let alerts: AlertItem[] = [];
  let sensors: SensorItem[] = [];

  // 특정 컬럼 동적 쿼리 결과
  let columnQueryResult: {
    matched: boolean;
    columns: { name: string; korean: string; reason: string }[];
    data: Record<string, unknown>[];
    stats?: Record<string, { avg?: number; min?: number; max?: number; sum?: number; count?: number }>;
    limit?: number;
    availableColumns?: string;
  } | null = null;

  // 1) 특정 변수/컬럼 쿼리인지 확인 → DB에서 직접 조회
  const isColumnQuery = isSpecificColumnQuery(q) || isLotQuery(q);
  if (isColumnQuery) {
    let conn;
    try {
      conn = await getConnection();
      const tableName = await getProcessDataTable(conn);
      if (tableName) {
        const columns = await getColumns(conn, tableName);
        const numericColumns = columns.filter((c) =>
          /int|decimal|float|double/i.test(c.type)
        );

        // 질문과 컬럼 매칭
        const matches = matchColumns(q, numericColumns);
        const topMatches = matches.filter((m) => m.score >= 30).slice(0, 5);

        // LOT 수 또는 기본 limit
        const limit = extractNumber(q) || 100;

        if (topMatches.length > 0) {
          // 매칭된 컬럼만 SELECT
          const selectCols = topMatches.map((m) => `\`${m.column}\``).join(', ');
          
          // LOT/id 컬럼 찾기 (있으면 함께 조회)
          const lotCol = columns.find((c) =>
            /lot|batch|id|no|번호/i.test(c.name)
          )?.name;
          const dateCol = columns.find((c) =>
            /date|time|created|recorded/i.test(c.name) || /date|time/i.test(c.type)
          )?.name;

          const orderBy = dateCol ? `ORDER BY \`${dateCol}\` DESC` : lotCol ? `ORDER BY \`${lotCol}\` DESC` : '';
          const extraCols = [lotCol, dateCol].filter(Boolean).map((c) => `\`${c}\``).join(', ');
          const fullSelect = extraCols ? `${extraCols}, ${selectCols}` : selectCols;

          const [rows]: any = await conn.query(
            `SELECT ${fullSelect} FROM \`${tableName}\` ${orderBy} LIMIT ${limit}`
          );

          // 통계 계산
          const stats: Record<string, { avg?: number; min?: number; max?: number; sum?: number; count?: number }> = {};
          for (const m of topMatches) {
            const values = (rows || [])
              .map((r: any) => r[m.column])
              .filter((v: any) => v != null && !Number.isNaN(Number(v)))
              .map((v: any) => Number(v));
            if (values.length > 0) {
              stats[m.column] = {
                count: values.length,
                sum: values.reduce((a: number, b: number) => a + b, 0),
                avg: values.reduce((a: number, b: number) => a + b, 0) / values.length,
                min: Math.min(...values),
                max: Math.max(...values),
              };
            }
          }

          columnQueryResult = {
            matched: true,
            columns: topMatches.map((m) => ({
              name: m.column,
              korean: columnToKorean(m.column),
              reason: m.reason,
            })),
            data: (rows || []).slice(0, 20), // 샘플 20개만
            stats,
            limit,
            availableColumns: describeColumns(numericColumns.slice(0, 30)),
          };

          console.log(`[Chat-context] Column query: matched ${topMatches.map((m) => m.column).join(', ')}, limit=${limit}`);
        } else {
          // 매칭 실패 → 사용 가능한 컬럼 목록 제공
          columnQueryResult = {
            matched: false,
            columns: [],
            data: [],
            availableColumns: describeColumns(numericColumns.slice(0, 30)),
          };
          console.log('[Chat-context] Column query: no match found');
        }
      }
      conn.release();
      conn = null;
    } catch (e) {
      console.warn('Column query error:', e);
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

  // 2) 기존 대시보드 API 호출 (품질/생산/에너지/효율)
  // 금일 생산량·불량률은 캘린더(calendar-month)와 동일한 값 사용
  let calendarTodayProduction: { production: number; unitKo: string; unitEn: string; defectRate?: number } | null = null;
  const requestedDate = parseRequestedDate(q);
  let requestedDateProduction: { year: number; month: number; day: number; production: number; defectRate: number; unitKo: string; unitEn: string } | null = null;

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const todayDay = now.getDate();

    // 특정 날짜 질문(예: 2026-2-4 생산량)이면 해당 연/월 캘린더도 조회 → 대시보드 캘린더와 동일한 수치 제공
    const needCalendarForRequestedDate = requestedDate != null && (fetchProduction || wantsProduction(q) || /생산|생산량|불량/.test(q));
    const calendarForRequested =
      needCalendarForRequestedDate && requestedDate
        ? fetch(`${base}/api/dashboard/calendar-month?year=${requestedDate.year}&month=${requestedDate.month}`)
        : Promise.resolve(null);

    const [summaryRes, qualityRes, productionRes, energyRes, efficiencyRes, calendarRes, calendarRequestedRes, alertsRes, realtimeRes] = await Promise.all([
      fetch(`${base}/api/dashboard/summary`),
      fetchQuality ? fetch(`${base}/api/dashboard/quality?period=${period}`) : Promise.resolve(null),
      fetchProduction ? fetch(`${base}/api/dashboard/production?period=${period}`) : Promise.resolve(null),
      fetchEnergy ? fetch(`${base}/api/dashboard/energy?period=${period}`) : Promise.resolve(null),
      fetchEfficiency ? fetch(`${base}/api/dashboard/efficiency?period=${period}`) : Promise.resolve(null),
      fetchProduction || fetchQuality || wantsProduction(q) ? fetch(`${base}/api/dashboard/calendar-month?year=${year}&month=${month}`) : Promise.resolve(null),
      calendarForRequested,
      fetchAlerts ? fetch(`${base}/api/dashboard/alerts`) : Promise.resolve(null),
      fetchRealtime ? fetch(`${base}/api/dashboard/realtime`) : Promise.resolve(null),
    ]);

    if (summaryRes.ok) summary = (await summaryRes.json()) as Summary;
    if (qualityRes?.ok) quality = (await qualityRes.json()) as Detail;
    if (productionRes?.ok) production = (await productionRes.json()) as Detail;
    if (energyRes?.ok) energy = (await energyRes.json()) as Detail;
    if (efficiencyRes?.ok) efficiency = (await efficiencyRes.json()) as Detail;
    if (alertsRes?.ok) {
      const a = (await alertsRes.json()) as { success?: boolean; alerts?: AlertItem[] };
      if (a.success && Array.isArray(a.alerts)) alerts = a.alerts;
    }
    if (realtimeRes?.ok) {
      const r = (await realtimeRes.json()) as { success?: boolean; sensors?: SensorItem[] };
      if (r.success && Array.isArray(r.sensors)) sensors = r.sensors;
    }

    if (calendarRes?.ok) {
      const cal = (await calendarRes.json()) as { success?: boolean; days?: { day: number; production: number; defectRate?: number }[]; productionUnit?: string; productionUnitEn?: string };
      if (cal.success && Array.isArray(cal.days)) {
        const todayRow = cal.days.find((d) => d.day === todayDay);
        if (todayRow != null) {
          calendarTodayProduction = {
            production: Number(todayRow.production ?? 0),
            unitKo: cal.productionUnit ?? '개',
            unitEn: cal.productionUnitEn ?? 'ea',
          };
          if (todayRow.defectRate != null) (calendarTodayProduction as Record<string, unknown>).defectRate = Number(todayRow.defectRate);
        }
      }
    }

    if (calendarRequestedRes?.ok && requestedDate) {
      const calReq = (await calendarRequestedRes.json()) as { success?: boolean; days?: { day: number; production: number; defectRate?: number }[]; productionUnit?: string; productionUnitEn?: string };
      if (calReq.success && Array.isArray(calReq.days)) {
        const dayRow = calReq.days.find((d) => d.day === requestedDate.day);
        if (dayRow != null) {
          requestedDateProduction = {
            year: requestedDate.year,
            month: requestedDate.month,
            day: requestedDate.day,
            production: Number(dayRow.production ?? 0),
            defectRate: Number(dayRow.defectRate ?? 0),
            unitKo: calReq.productionUnit ?? '개',
            unitEn: calReq.productionUnitEn ?? 'ea',
          };
        }
      }
    }
  } catch (e) {
    console.warn('Chat-context fetch error:', e);
  }

  const fromDb =
    !!summary.fromDb ||
    !!columnQueryResult?.matched ||
    !!(quality?.success && (quality.data?.length || quality.byLine?.length)) ||
    !!(production?.success && (production.data?.length || production.byLine?.length)) ||
    !!(energy?.success && energy.data?.length) ||
    !!(efficiency?.success && (efficiency.data?.length || efficiency.byLine?.length)) ||
    alerts.length > 0 ||
    sensors.length > 0;

  const summaryData = summary.data ?? summary;
  if (calendarTodayProduction != null && typeof summaryData === 'object' && summaryData !== null) {
    const s = summaryData as Record<string, unknown>;
    s.productionToday = calendarTodayProduction.production;
    s.productionTodayUnitKo = calendarTodayProduction.unitKo;
    s.productionTodayUnitEn = calendarTodayProduction.unitEn;
    s.productionTodaySource = 'calendar';
    if (calendarTodayProduction.defectRate != null) {
      s.defectRateToday = calendarTodayProduction.defectRate;
      s.defectRateTodaySource = 'calendar';
    }
  }

  const includeProcessEnergy = fetchEnergy || wantsProcessEnergy(q);

  return NextResponse.json({
    success: true,
    period,
    summary: summaryData,
    calendarTodayProduction: calendarTodayProduction ?? undefined,
    requestedDateProduction: requestedDateProduction ?? undefined,
    processEnergyTable: includeProcessEnergy ? PROCESS_ENERGY_TABLE : undefined,
    quality: fetchQuality ? quality : undefined,
    production: fetchProduction ? production : undefined,
    energy: fetchEnergy ? energy : undefined,
    efficiency: fetchEfficiency ? efficiency : undefined,
    alerts: fetchAlerts ? alerts : undefined,
    sensors: fetchRealtime ? sensors : undefined,
    columnQuery: columnQueryResult,
    fromDb,
    recentDefectLotId: recentDefectLotId ?? undefined,
    recentDefectLotNoData: recentDefectLotNoData || undefined,
    recentDefectLotMessage,
  });
}
