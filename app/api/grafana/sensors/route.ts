import { NextResponse } from 'next/server';
import { ALL_SENSOR_IDS } from '@/lib/influxdb-sensors';

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

/**
 * GET /api/grafana/sensors
 * Grafana Datasource Proxy를 통해 InfluxDB에서 공정별 센서 최신 값을 조회합니다.
 * (가스 유량, 배기 압력 등 실시간 값)
 *
 * env: GRAFANA_URL, GRAFANA_TOKEN, GRAFANA_DATASOURCE_UID(선택)
 *      INFLUXDB_ORG, INFLUXDB_BUCKET (Flux 쿼리용)
 *
 * GRAFANA_DATASOURCE_UID 미설정 시 InfluxDB 타입 첫 번째 datasource 자동 사용.
 * 미설정 시 sensors: {}, lastUpdated: null 반환 → UI에서 "데이터 수신 대기 중" 표시
 */
export async function GET() {
  const grafanaUrl = process.env.GRAFANA_URL?.replace(/\/$/, '');
  const grafanaToken = process.env.GRAFANA_TOKEN;
  const datasourceUid = process.env.GRAFANA_DATASOURCE_UID;
  const org = process.env.INFLUXDB_ORG ?? 'ktca';
  const bucket = process.env.INFLUXDB_BUCKET ?? 'fdc';

  const result: Record<string, SensorReading> = {};
  let lastUpdated: string | null = null;

  if (!grafanaUrl || !grafanaToken) {
    return NextResponse.json({
      success: true,
      sensors: result,
      lastUpdated,
      source: 'grafana',
      message: 'GRAFANA_URL or GRAFANA_TOKEN not configured',
    });
  }

  const sensorIds = ALL_SENSOR_IDS;
  if (sensorIds.length === 0) {
    return NextResponse.json({ success: true, sensors: result, lastUpdated, source: 'grafana' });
  }

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
    } catch (e) {
      console.error('[grafana/sensors] Failed to list datasources:', e);
    }
  }

  if (!uid) {
    return NextResponse.json({
      success: true,
      sensors: result,
      lastUpdated,
      source: 'grafana',
      message: 'No InfluxDB datasource found in Grafana',
    });
  }

  const fluxFilter = sensorIds.map((id) => `r["sensor_id"] == "${id}"`).join(' or ');
  const flux = `
from(bucket: "${bucket}")
  |> range(start: -5m)
  |> filter(fn: (r) => ${fluxFilter})
  |> group(columns: ["sensor_id"])
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

    if (!res.ok) {
      const text = await res.text();
      console.error('[grafana/sensors] Grafana proxy error:', res.status, text);
      return NextResponse.json({
        success: true,
        sensors: result,
        lastUpdated,
        source: 'grafana',
        error: res.statusText,
      });
    }

    const csv = await res.text();
    const lines = csv.split('\n').filter((l) => l.trim());
    if (lines.length > 1) {
      const header = lines[0].split(',');
      const timeIdx = header.findIndex((h) => h === '_time');
      const valueIdx = header.findIndex((h) => h === '_value');
      const sensorIdCol = header.findIndex((h) => h === 'sensor_id');

      for (let i = 1; i < lines.length; i++) {
        const parts = parseCsvLine(lines[i]);
        const sensorId = sensorIdCol >= 0 ? parts[sensorIdCol]?.trim() : '';
        const timeVal = timeIdx >= 0 ? parts[timeIdx]?.trim() : '';
        const valueNum = valueIdx >= 0 ? parseFloat(parts[valueIdx]) : NaN;
        if (sensorId && !Number.isNaN(valueNum)) {
          result[sensorId] = { value: valueNum, time: timeVal || new Date().toISOString() };
          if (timeVal && (!lastUpdated || timeVal > lastUpdated)) lastUpdated = timeVal;
        }
      }
    }

    if (!lastUpdated && Object.keys(result).length > 0) {
      lastUpdated = new Date().toISOString();
    }
  } catch (e) {
    console.error('[grafana/sensors] Fetch error:', e);
  }

  return NextResponse.json({
    success: true,
    sensors: result,
    lastUpdated,
    source: 'grafana',
  });
}
