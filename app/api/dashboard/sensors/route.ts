import { NextResponse } from 'next/server';
import { ALL_SENSOR_IDS, EQUIPMENT_TO_SENSOR_MAPPING } from '@/lib/influxdb-sensors';

/** EQUIPMENT_TO_SENSOR_MAPPING + ALL_SENSOR_IDS 합집합 (모든 설비 센서 한 번에 쿼리) */
const ALL_MAPPED_SENSOR_IDS = [...new Set([
  ...ALL_SENSOR_IDS,
  ...Object.values(EQUIPMENT_TO_SENSOR_MAPPING).flat(),
])];

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SensorReading = { value: number; time: string };

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if ((c === ',' && !inQuotes) || c === '\r') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseInfluxCsv(csv: string, result: Record<string, SensorReading>): string | null {
  const lines = csv.split('\n');
  let lastTime: string | null = null;
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
    const sensorCol = header.findIndex((h) => h.trim() === 'sensor');
    const idCol = header.findIndex((h) => h.trim() === 'id');

    const sensorIdIdx =
      sensorIdCol >= 0 ? sensorIdCol : idCol >= 0 ? idCol : sensorCol >= 0 ? sensorCol : fieldCol;
    if (timeIdx < 0 || valueIdx < 0 || sensorIdIdx < 0) continue;

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
      const rawId = (parts[sensorIdIdx] ?? '').trim().replace(/^"|"$/g, '');
      const timeVal = (parts[timeIdx] ?? '').trim().replace(/^"|"$/g, '');
      const valueNum = parseFloat(String(parts[valueIdx] ?? '').trim());
      if (rawId && !Number.isNaN(valueNum)) {
        const reading: SensorReading = { value: valueNum, time: timeVal || new Date().toISOString() };
        result[rawId] = reading;
        const normalizedId = rawId.replace(/_/g, '-');
        if (normalizedId !== rawId) result[normalizedId] = reading;
        if (timeVal && (!lastTime || timeVal > lastTime)) lastTime = timeVal;
      }
    }
  }
  return lastTime;
}

async function fetchFromInfluxDirect(
  result: Record<string, SensorReading>
): Promise<{ lastUpdated: string | null; success: boolean }> {
  const url = process.env.INFLUXDB_URL?.replace(/\/$/, '');
  const token = process.env.INFLUXDB_TOKEN;
  const org = process.env.INFLUXDB_ORG ?? 'ktca';
  const bucket = process.env.INFLUXDB_BUCKET ?? 'fdc';
  if (!url || !token) return { lastUpdated: null, success: false };

  const sensorIds = ALL_MAPPED_SENSOR_IDS;
  if (sensorIds.length === 0) return { lastUpdated: null, success: true };

  const fluxFilter = sensorIds.map((id) => `r["sensor_id"] == "${id}" or r["_field"] == "${id}"`).join(' or ');
  const flux = `
from(bucket: "${bucket}")
  |> range(start: -1m)
  |> filter(fn: (r) => ${fluxFilter})
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
    if (!res.ok) return { lastUpdated: null, success: false };
    const csv = await res.text();
    const lastUpdated = parseInfluxCsv(csv, result);
    return { lastUpdated, success: Object.keys(result).length > 0 };
  } catch {
    return { lastUpdated: null, success: false };
  }
}

async function fetchFromGrafanaProxy(
  result: Record<string, SensorReading>
): Promise<{ lastUpdated: string | null; success: boolean }> {
  const grafanaUrl = process.env.GRAFANA_URL?.replace(/\/$/, '');
  const grafanaToken = process.env.GRAFANA_TOKEN;
  const datasourceUid = process.env.GRAFANA_DATASOURCE_UID;
  const org = process.env.INFLUXDB_ORG ?? 'ktca';
  const bucket = process.env.INFLUXDB_BUCKET ?? 'fdc';
  if (!grafanaUrl || !grafanaToken) return { lastUpdated: null, success: false };

  let uid = datasourceUid;
  if (!uid) {
    try {
      const dsRes = await fetch(`${grafanaUrl}/api/datasources`, {
        headers: { Authorization: `Bearer ${grafanaToken}`, Accept: 'application/json' },
        cache: 'no-store',
      });
      if (dsRes.ok) {
        const datasources = (await dsRes.json()) as Array<{ uid: string; type: string }>;
        const influx = datasources.find((ds) => ds.type === 'influxdb');
        if (influx) uid = influx.uid;
      }
    } catch {
      return { lastUpdated: null, success: false };
    }
  }
  if (!uid) return { lastUpdated: null, success: false };

  const sensorIds = ALL_MAPPED_SENSOR_IDS;
  const fluxFilter = sensorIds.map((id) => `r["sensor_id"] == "${id}" or r["_field"] == "${id}"`).join(' or ');
  const flux = `
from(bucket: "${bucket}")
  |> range(start: -1m)
  |> filter(fn: (r) => ${fluxFilter})
  |> last()
`.trim();

  const proxyUrl = `${grafanaUrl}/api/datasources/proxy/uid/${uid}/api/v2/query?org=${encodeURIComponent(org)}`;
  try {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grafanaToken}`,
        'Content-Type': 'application/vnd.flux',
        Accept: 'application/csv',
      },
      body: flux,
      cache: 'no-store',
    });
    if (!res.ok) return { lastUpdated: null, success: false };
    const csv = await res.text();
    const lastUpdated = parseInfluxCsv(csv, result);
    return { lastUpdated, success: Object.keys(result).length > 0 };
  } catch {
    return { lastUpdated: null, success: false };
  }
}

/**
 * GET /api/dashboard/sensors
 * InfluxDB 직접 연결 → Grafana 프록시 순으로 시도하여 하단 차트와 동일한 센서 데이터 반환
 * 3D 설비 툴팁/우측 패널과 하단 Grafana 차트가 같은 데이터 소스 사용
 */
export async function GET() {
  const result: Record<string, SensorReading> = {};
  let lastUpdated: string | null = null;
  let source = 'none';

  const influxResult = await fetchFromInfluxDirect(result);
  if (influxResult.success && Object.keys(result).length > 0) {
    lastUpdated = influxResult.lastUpdated;
    source = 'influxdb';
  } else {
    Object.keys(result).forEach((k) => delete result[k]);
    const grafanaResult = await fetchFromGrafanaProxy(result);
    if (grafanaResult.success && Object.keys(result).length > 0) {
      lastUpdated = grafanaResult.lastUpdated;
      source = 'grafana';
    }
  }

  if (!lastUpdated && Object.keys(result).length > 0) {
    lastUpdated = new Date().toISOString();
  }

  const normalized: Record<string, SensorReading> = { ...result };
  for (const id of ALL_MAPPED_SENSOR_IDS) {
    if (normalized[id]) continue;
    const withUnderscore = id.replace(/-/g, '_');
    const withDash = id.replace(/_/g, '-');
    const lower = id.toLowerCase();
    const fromUnderscore = result[withUnderscore];
    const fromDash = result[withDash];
    const fromLower = result[lower];
    if (fromUnderscore) normalized[id] = fromUnderscore;
    else if (fromDash) normalized[id] = fromDash;
    else if (fromLower) normalized[id] = fromLower;
  }

  return NextResponse.json({
    success: true,
    sensors: normalized,
    lastUpdated,
    source,
  });
}
