import { NextResponse } from 'next/server';
import { ALL_SENSOR_IDS } from '@/lib/influxdb-sensors';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SensorReading = { value: number; time: string };

/**
 * GET /api/influxdb/sensors
 * InfluxDB에서 공정별 센서 최신 값을 조회합니다.
 * env: INFLUXDB_URL, INFLUXDB_TOKEN, INFLUXDB_ORG, INFLUXDB_BUCKET
 * 미설정 시 sensors: {}, lastUpdated: null 반환 → UI에서 "데이터 수신 대기 중" 표시
 */
export async function GET() {
  const url = process.env.INFLUXDB_URL;
  const token = process.env.INFLUXDB_TOKEN;
  const org = process.env.INFLUXDB_ORG ?? '';
  const bucket = process.env.INFLUXDB_BUCKET ?? 'sensors';

  const result: Record<string, SensorReading> = {};
  let lastUpdated: string | null = null;

  if (!url || !token) {
    return NextResponse.json({
      success: true,
      sensors: result,
      lastUpdated,
    });
  }

  const sensorIds = ALL_SENSOR_IDS;
  if (sensorIds.length === 0) {
    return NextResponse.json({ success: true, sensors: result, lastUpdated });
  }

  const fluxFilter = sensorIds.map((id) => `r["sensor_id"] == "${id}"`).join(' or ');
  const flux = `
from(bucket: "${bucket}")
  |> range(start: -5m)
  |> filter(fn: (r) => ${fluxFilter})
  |> group(columns: ["sensor_id"])
  |> last()
`.trim();

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/v2/query?org=${encodeURIComponent(org)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/vnd.flux',
        'Accept': 'application/csv',
      },
      body: flux,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('InfluxDB query error:', res.status, text);
      return NextResponse.json({
        success: true,
        sensors: result,
        lastUpdated,
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
    console.error('InfluxDB fetch error:', e);
  }

  return NextResponse.json({
    success: true,
    sensors: result,
    lastUpdated,
  });
}

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
