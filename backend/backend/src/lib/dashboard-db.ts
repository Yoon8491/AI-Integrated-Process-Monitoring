import mysql from 'mysql2/promise';

// 공정 데이터용 DB (simulation_results 테이블 사용, PROCESS_DB_NAME/DB_NAME으로 DB 지정)
const dbName = process.env.PROCESS_DB_NAME || process.env.DB_NAME || 'factory';

function getConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName,
    connectTimeout: 10000,
  };
}

// 연결 풀 생성 (재사용 가능)
let processPool: mysql.Pool | null = null;

function getProcessPool(): mysql.Pool {
  if (!processPool) {
    processPool = mysql.createPool({
      ...getConfig(),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
    
    processPool.on('error', (err) => {
      console.error('Process DB pool error:', err);
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        processPool = null; // 재생성하도록 설정
      }
    });
  }
  return processPool;
}

export async function getConnection(): Promise<mysql.PoolConnection> {
  const pool = getProcessPool();
  return pool.getConnection();
}

/** MariaDB/MySQL 식별자(테이블·컬럼명) 이스케이프. 공백·특수문자·백틱 포함 시에도 안전 */
export function escapeSqlId(name: string): string {
  const safe = String(name).replace(/`/g, '``');
  return '`' + safe + '`';
}

/** 동적 SQL에 넣을 컬럼명이 안전한지. 영문·숫자·밑줄·공백만 허용 (^, 따옴표, 백틱 등 제외) */
export function isSafeColumnName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && /^[a-zA-Z0-9_\s]+$/.test(name);
}

/** 테이블 목록 조회 */
export async function getTables(conn: mysql.Connection): Promise<string[]> {
  const [rows] = await conn.query<any[]>('SHOW TABLES');
  const key = rows?.length ? Object.keys(rows[0])[0] : null;
  return key ? rows.map((r) => r[key]).filter(Boolean) : [];
}

/** 테이블 컬럼 정보 (이름, 타입) */
export async function getColumns(
  conn: mysql.Connection,
  table: string
): Promise<{ name: string; type: string }[]> {
  const [rows] = await conn.query<any[]>(
    `SELECT COLUMN_NAME as name, DATA_TYPE as type
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [dbName, table]
  );
  return rows || [];
}

/** 날짜형 컬럼명 후보 (simulation_results 등: timestamp 우선) */
const DATE_COLUMNS = ['timestamp', 'date', 'created_at', 'recorded_at', 'dt', 'record_date'];
/** 수치형 컬럼명 후보 (생산량 등) */
const VALUE_COLUMNS = ['quantity', 'amount', 'count', 'qty', 'value', 'production', 'total'];
/** 합계용 수치 컬럼 (에너지 등) */
const SUM_COLUMNS = ['consumption', 'usage', 'kwh', 'value', 'amount', 'cost'];

function pickColumn(columns: { name: string; type: string }[], candidates: string[]) {
  const names = columns.map((c) => c.name.toLowerCase());
  for (const c of candidates) {
    if (names.includes(c.toLowerCase())) return c;
    const found = columns.find((col) => col.name.toLowerCase().includes(c));
    if (found) return found.name;
  }
  return null;
}

function isDateType(type: string) {
  const t = (type || '').toLowerCase();
  return t.includes('date') || t.includes('time') || t === 'timestamp';
}

function isNumericType(type: string) {
  const t = (type || '').toLowerCase();
  return t.includes('int') || t.includes('decimal') || t.includes('float') || t.includes('double');
}

/** 테이블에서 날짜 컬럼 1개, 수치 컬럼 1개 찾기 */
export function findDateAndValueColumns(columns: { name: string; type: string }[]) {
  const dateCol =
    pickColumn(columns, DATE_COLUMNS) ||
    columns.find((c) => isDateType(c.type))?.name ||
    null;
  const valueCol =
    pickColumn(columns, VALUE_COLUMNS) ||
    pickColumn(columns, SUM_COLUMNS) ||
    columns.find((c) => isNumericType(c.type))?.name ||
    null;
  return { dateCol, valueCol };
}

/** 타임존 기준 오늘 날짜 (YYYY-MM-DD). DB 데이터가 KST 등이면 BACKEND_DATE_TZ=Asia/Seoul 사용 */
export function getTodayDateString(): string {
  const tz = process.env.BACKEND_DATE_TZ || 'Asia/Seoul';
  try {
    const s = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  } catch {
    // fallback: 서버 로컬
  }
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, '0');
  const d = String(n.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** LOT별 공정현황 등에서 사용할 날짜 문자열 (todayStr 기준, 주/월은 같은 달력 기준). 주: 월~일, 월: 해당 월 1일~말일 */
export function getDashboardDateStrings(): {
  todayStr: string;
  weekStartStr: string;
  weekEndStr: string;
  firstOfMonth: string;
  lastOfMonthStr: string;
} {
  const todayStr = getTodayDateString();
  const [y, m, d] = todayStr.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const monOffset = (dayOfWeek + 6) % 7;
  const monDate = new Date(Date.UTC(y, m - 1, d - monOffset));
  const sunDate = new Date(monDate);
  sunDate.setUTCDate(monDate.getUTCDate() + 6);
  const weekStartStr = `${monDate.getUTCFullYear()}-${pad(monDate.getUTCMonth() + 1)}-${pad(monDate.getUTCDate())}`;
  const weekEndStr = `${sunDate.getUTCFullYear()}-${pad(sunDate.getUTCMonth() + 1)}-${pad(sunDate.getUTCDate())}`;
  const firstOfMonth = `${y}-${pad(m)}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastOfMonthStr = `${y}-${pad(m)}-${pad(lastDay)}`;
  return { todayStr, weekStartStr, weekEndStr, firstOfMonth, lastOfMonthStr };
}

/** 기간 조건 (day: 오늘, week: 최근 7일, month: 최근 4주). day는 정확한 날짜 매칭용 */
export function periodCondition(
  dateCol: string,
  period: 'day' | 'week' | 'month'
): string {
  const col = dateCol || 'timestamp';
  if (period === 'day') return `DATE(\`${col}\`) = ?`;
  if (period === 'week') return `\`${col}\` >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`;
  return `\`${col}\` >= DATE_SUB(CURDATE(), INTERVAL 28 DAY)`;
}

/** 공정 데이터용 메인 테이블. simulation_results 기본 (prediction 컬럼 사용) */
export async function getProcessDataTable(_conn: mysql.Connection): Promise<string> {
  const fixed = process.env.PROCESS_TABLE_NAME?.trim();
  return fixed || 'simulation_results';
}

/** defect_results 테이블 존재 시 해당 테이블명 반환 (품질/불량 전용 API용) */
export async function getDefectResultsTable(conn: mysql.Connection): Promise<string | null> {
  const tables = await getTables(conn);
  return tables.find((t) => t.toLowerCase() === 'defect_results') ?? null;
}

/** 차트 메인 데이터용 테이블. simulation_results 우선, 없으면 공정 메인 테이블 사용 */
export async function getChartDataTable(conn: mysql.Connection): Promise<string> {
  const wanted = (process.env.CHART_DATA_TABLE || 'simulation_results').trim().toLowerCase();
  const tables = await getTables(conn);
  const found = tables.find((t) => t.toLowerCase() === wanted);
  return found ?? (await getProcessDataTable(conn));
}

/** 비교용 테이블(예: data_sample) 존재 시 테이블명 반환. 환경변수 COMPARISON_TABLE_NAME 지정 가능, 기본값 data_sample */
export async function getComparisonTable(conn: mysql.Connection): Promise<string | null> {
  const wanted = (process.env.COMPARISON_TABLE_NAME || 'data_sample').trim().toLowerCase();
  if (!wanted) return null;
  const tables = await getTables(conn);
  const found = tables.find((t) => t.toLowerCase() === wanted) ?? null;
  return found;
}

/** 컬럼명이 후보 중 하나를 포함하거나 일치하면 해당 컬럼명 반환 */
function findColumn(columns: { name: string; type: string }[], candidates: string[]): string | null {
  const lower = (s: string) => s.toLowerCase();
  for (const cand of candidates) {
    const exact = columns.find((c) => lower(c.name) === lower(cand));
    if (exact) return exact.name;
    const partial = columns.find(
      (c) => lower(c.name).includes(lower(cand)) || lower(cand).includes(lower(c.name))
    );
    if (partial) return partial.name;
  }
  return null;
}

/** 날짜형 컬럼 찾기. timestamp 우선 */
function findDateColumn(columns: { name: string; type: string }[]): string | null {
  const dateNames = ['timestamp', 'date', 'created_at', 'recorded_at', 'dt', 'time', '날짜'];
  const byName = findColumn(columns, dateNames);
  if (byName) return byName;
  return columns.find((c) => isDateType(c.type))?.name || null;
}

/** 공정 테이블 한 개의 컬럼 매핑: 생산/품질/에너지/설비 등에 쓸 컬럼 자동 감지 */
export interface ProcessColumnMap {
  table: string;
  dateCol: string | null;
  quantityCol: string | null;
  passRateCol: string | null;
  defectCol: string | null;
  consumptionCol: string | null;
  efficiencyCol: string | null;
  lineCol: string | null;
  /** LOT 식별용 컬럼 (lot_id, lot, batch, id 등) */
  lotCol: string | null;
  /** 합불여부 컬럼 (pass/fail, 합격/불량 등) */
  resultCol: string | null;
  /** 기타 수치 컬럼들 (대시보드 추가 KPI용) */
  numericCols: string[];
}

export async function getProcessColumnMap(
  conn: mysql.Connection,
  tableName: string
): Promise<ProcessColumnMap> {
  const columns = await getColumns(conn, tableName);
  const dateCol = findDateColumn(columns);
  const quantityCol = findColumn(columns, ['quantity', 'amount', 'count', 'qty', 'output', '생산', '수량']);
  const passRateCol = findColumn(columns, ['pass_rate', 'pass', 'quality', 'ok_rate', '양품률', '품질']);
  const defectCol = findColumn(columns, ['quality_defect', 'defect', 'defect_rate', 'fail', 'ng', '불량']);
  const consumptionCol = findColumn(columns, ['consumption', 'usage', 'kwh', 'energy', 'power', '에너지', '소비']);
  const efficiencyCol = findColumn(columns, ['efficiency', 'uptime', 'oee', 'rate', '효율', '가동률']);
  const lineCol = findColumn(columns, ['line', 'line_id', 'line_name', '라인', '공정']);
  const lotCol = findColumn(columns, ['lot_id', 'lot', 'batch', 'lot_no', 'batch_id', 'LOT', 'id']);
  const resultCol = findColumn(columns, [
    'quality_defect',
    'y_defect',
    'prediction',
    'result',
    'pass_fail',
    'judge',
    'judgment',
    '판정',
    '합불',
    'ok_ng',
    'pass_fail_result',
    'quality_result',
    'judgement',
  ]);

  const numericCols = columns.filter((c) => isNumericType(c.type)).map((c) => c.name);

  const quantityFallback =
    quantityCol ||
    numericCols.find((n) => !/pass|rate|quality|efficiency|uptime|defect/i.test(n)) ||
    numericCols[0] ||
    null;

  return {
    table: tableName,
    dateCol,
    quantityCol: quantityFallback,
    passRateCol,
    defectCol,
    consumptionCol,
    efficiencyCol,
    lineCol,
    lotCol,
    resultCol,
    numericCols,
  };
}

