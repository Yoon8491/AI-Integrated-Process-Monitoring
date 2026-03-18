import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export type RealtimeReading = { value: number; time: string };

/** key-value 형태로 모든 설비/센서 데이터. data['RHK_FLOW'], data['FLOW-001'], data['FLOW_001'] 등 즉시 접근 */
export type FacilityDataMap = Record<string, RealtimeReading>;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if ((c === ',' && !inQuotes) || c === '\r') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Flux CSV 여러 결과 테이블 파싱 → 동일 데이터를 여러 키(sensor_id, _field, 정규화)로 저장해 어떤 키로든 접근 가능하게 */
function parseInfluxCsvToMap(csv: string): { data: FacilityDataMap; lastUpdated: string | null } {
  const data: FacilityDataMap = {};
  let lastUpdated: string | null = null;
  const lines = csv.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    i++;
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;

    const header = parseCsvLine(line);
    const timeIdx = header.findIndex((h) => h.trim() === '_time');
    let valueIdx = header.findIndex((h) => h.trim() === '_value');
    if (valueIdx < 0) valueIdx = header.findIndex((h) => h.trim() === 'value');
    const sensorIdCol = header.findIndex((h) => h.trim() === 'sensor_id');
    const fieldCol = header.findIndex((h) => h.trim() === '_field');
    const idCol = header.findIndex((h) => h.trim() === 'id');
    const sensorCol = header.findIndex((h) => h.trim() === 'sensor');
    const keyCol = sensorIdCol >= 0 ? sensorIdCol : fieldCol >= 0 ? fieldCol : idCol >= 0 ? idCol : sensorCol;
    if (timeIdx < 0 || valueIdx < 0 || keyCol < 0) continue;

    while (i < lines.length) {
      const dataLine = lines[i];
      const dataTrimmed = dataLine.trim();
      i++;
      if (!dataTrimmed) break;
      if (dataTrimmed.startsWith('#')) {
        i--;
        break;
      }
      const parts = parseCsvLine(dataLine);
      const rawKey = (parts[keyCol] ?? '').trim().replace(/^"|"$/g, '');
      const timeVal = (parts[timeIdx] ?? '').trim().replace(/^"|"$/g, '');
      const valueNum = parseFloat(String(parts[valueIdx] ?? '').trim());
      if (!rawKey || Number.isNaN(valueNum)) continue;

      const reading: RealtimeReading = { value: valueNum, time: timeVal || new Date().toISOString() };
      const keyHyphen = rawKey.replace(/_/g, '-');
      const keyUnderscore = rawKey.replace(/-/g, '_');
      data[rawKey] = reading;
      data[keyHyphen] = reading;
      data[keyUnderscore] = reading;
      if (timeVal && (!lastUpdated || timeVal > lastUpdated)) lastUpdated = timeVal;
    }
  }
  return { data, lastUpdated };
}

/** 소성(RHK) 설비 전용: flow_rate(유량), exhaust_pressure(배기압력) 최근 1분 Flux 쿼리 */
const RHK_FLUX_QUERY = `
from(bucket: "BUCKET")
  |> range(start: -1m)
  MEASUREMENT_FILTER
  |> filter(fn: (r) => r._field == "flow_rate" or r._field == "exhaust_pressure")
  |> last()
`.trim();

/** RHK Flux 결과의 _field 값을 카드 키(FLOW-001, PRESS-004 등)로 매핑 */
const RHK_FIELD_TO_KEYS: Record<string, string[]> = {
  flow_rate: ['FLOW-001', 'FLOW_001', 'RHK_FLOW', 'RHK유량'],
  exhaust_pressure: ['PRESS-004', 'PRESS_004', 'RHK_PRESS', 'RHK배기압력'],
};

/**
 * 소성(RHK) 설비 최근 1분 flow_rate, exhaust_pressure 조회 후
 * FacilityDataMap 키(FLOW-001, PRESS-004 등)로 매핑. 값 없으면 0으로 넣어 UI에서 '0' 표시.
 */
async function fetchRHKLastMinute(): Promise<{
  success: boolean;
  data: FacilityDataMap;
  lastUpdated: string | null;
  error?: string;
}> {
  const url = process.env.INFLUXDB_URL?.replace(/\/$/, '');
  const token = process.env.INFLUXDB_TOKEN;
  const org = process.env.INFLUXDB_ORG ?? '';
  const bucket = process.env.INFLUXDB_BUCKET ?? 'fdc';
  const measurement = process.env.INFLUXDB_RHK_MEASUREMENT?.trim(); // optional, e.g. "sintering"

  const data: FacilityDataMap = {};
  const nowIso = new Date().toISOString();
  let lastUpdated: string | null = null;

  if (!url || !token) {
    return {
      success: false,
      data: {},
      lastUpdated: null,
      error: 'InfluxDB not configured (INFLUXDB_URL, INFLUXDB_TOKEN in .env)',
    };
  }

  const measurementFilter = measurement
    ? `  |> filter(fn: (r) => r._measurement == "${measurement}")`
    : '';
  const flux = RHK_FLUX_QUERY.replace('BUCKET', bucket).replace(
    'MEASUREMENT_FILTER',
    measurementFilter
  );

  try {
    const res = await fetch(`${url}/api/v2/query?org=${encodeURIComponent(org)}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/vnd.flux',
        Accept: 'application/csv',
      },
      body: flux,
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[influxdb/realtime] RHK query error:', res.status, text);
      return {
        success: false,
        data: {},
        lastUpdated: null,
        error: res.statusText,
      };
    }

    const csv = await res.text();
    const lines = csv.split('\n').map((l) => l.trim()).filter(Boolean);
    const headerLineIdx = lines.findIndex((l) => !l.startsWith('#') && l.includes('_field'));
    const header = parseCsvLine(headerLineIdx >= 0 ? lines[headerLineIdx] ?? '' : '');
    const timeIdx = header.findIndex((h) => h.trim() === '_time');
    const valueIdx = header.findIndex((h) => h.trim() === '_value');
    const fieldIdx = header.findIndex((h) => h.trim() === '_field');

    if (valueIdx < 0 || fieldIdx < 0) {
      // 데이터 없음: flow_rate, exhaust_pressure 모두 0으로 넣어 UI에 '0' 표시
      for (const keys of Object.values(RHK_FIELD_TO_KEYS)) {
        const reading: RealtimeReading = { value: 0, time: nowIso };
        for (const k of keys) data[k] = reading;
      }
      return { success: true, data, lastUpdated: nowIso };
    }

    const seenFields = new Set<string>();
    for (let i = headerLineIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#')) continue;
      const parts = parseCsvLine(line);
      const field = (parts[fieldIdx] ?? '').trim().replace(/^"|"$/g, '');
      const keys = RHK_FIELD_TO_KEYS[field];
      if (!keys) continue;
      const rawVal = (parts[valueIdx] ?? '').trim().replace(/^"|"$/g, '');
      const value = Number(rawVal);
      const numVal = Number.isFinite(value) ? value : 0;
      const timeVal = timeIdx >= 0 ? (parts[timeIdx] ?? '').trim().replace(/^"|"$/g, '') || nowIso : nowIso;
      const reading: RealtimeReading = { value: numVal, time: timeVal };
      for (const k of keys) data[k] = reading;
      seenFields.add(field);
      if (timeVal && (!lastUpdated || timeVal > lastUpdated)) lastUpdated = timeVal;
    }

    // 값 없을 경우 0으로 채워서 '데이터 없음' 대신 '0' 표시
    for (const [field, keys] of Object.entries(RHK_FIELD_TO_KEYS)) {
      if (seenFields.has(field)) continue;
      const reading: RealtimeReading = { value: 0, time: nowIso };
      for (const k of keys) data[k] = reading;
    }
    if (Object.keys(data).length > 0 && !lastUpdated) lastUpdated = nowIso;

    return { success: true, data, lastUpdated };
  } catch (e) {
    console.error('[influxdb/realtime] RHK fetch error:', e);
    return {
      success: false,
      data: {},
      lastUpdated: null,
      error: e instanceof Error ? e.message : 'Network error',
    };
  }
}

/**
 * .env 의 INFLUXDB_* 변수만 사용.
 * from(bucket) |> range(start: -1m) |> last() 로 모든 _field 최신값을 한 번에 조회.
 */
async function fetchAllFacilityData(): Promise<{
  success: boolean;
  data: FacilityDataMap;
  lastUpdated: string | null;
  error?: string;
}> {
  const url = process.env.INFLUXDB_URL?.replace(/\/$/, '');
  const token = process.env.INFLUXDB_TOKEN;
  const org = process.env.INFLUXDB_ORG ?? '';
  const bucket = process.env.INFLUXDB_BUCKET ?? 'fdc';

  const data: FacilityDataMap = {};
  let lastUpdated: string | null = null;

  if (!url || !token) {
    return {
      success: false,
      data: {},
      lastUpdated: null,
      error: 'InfluxDB not configured (INFLUXDB_URL, INFLUXDB_TOKEN in .env)',
    };
  }

  // 개별 쿼리 없이 한 번의 호출로 bucket 내 range(-1m) 모든 시리즈의 last() 조회
  const flux = `
from(bucket: "${bucket}")
  |> range(start: -1m)
  |> group()
  |> last()
`.trim();

  try {
    const res = await fetch(`${url}/api/v2/query?org=${encodeURIComponent(org)}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/vnd.flux',
        Accept: 'application/csv',
      },
      body: flux,
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[influxdb/realtime] query error:', res.status, text);
      return {
        success: false,
        data: {},
        lastUpdated: null,
        error: res.statusText,
      };
    }

    const csv = await res.text();
    const parsed = parseInfluxCsvToMap(csv);
    Object.assign(data, parsed.data);
    lastUpdated = parsed.lastUpdated ?? null;
    if (Object.keys(data).length > 0 && !lastUpdated) lastUpdated = new Date().toISOString();

    return { success: true, data, lastUpdated };
  } catch (e) {
    console.error('[influxdb/realtime] fetch error:', e);
    return {
      success: false,
      data: {},
      lastUpdated: null,
      error: e instanceof Error ? e.message : 'Network error',
    };
  }
}

export async function GET() {
  const result = await fetchAllFacilityData();
  const rhk = await fetchRHKLastMinute();

  // 소성(RHK) 전용 쿼리 결과 병합: flow_rate → FLOW-001/RHK유량, exhaust_pressure → PRESS-004/RHK배기압력
  const mergedData: FacilityDataMap = { ...result.data, ...rhk.data };
  const mergedLastUpdated = rhk.lastUpdated ?? result.lastUpdated;

  // InfluxDB 연결 성공( RHK 쿼리 200 응답) 시 연결 오류 제거, 정상 데이터로 UI 갱신
  const success = result.success || rhk.success;
  const error = success ? undefined : (result.error ?? rhk.error);

  return NextResponse.json({
    success,
    data: mergedData,
    lastUpdated: mergedLastUpdated,
    ...(error && { error }),
  });
}
