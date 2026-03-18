import { NextRequest, NextResponse } from 'next/server';
import { ALL_SENSOR_IDS } from '@/lib/influxdb-sensors';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/influxdb/sensors/trend?range=1h
 * 최근 1시간(또는 range 파라미터) 구간의 센서별 시계열을 반환합니다.
 * 미니 라인 차트용. 미설정 시 빈 시계열 반환.
 */
export async function GET(request: NextRequest) {
  const range = request.nextUrl.searchParams.get('range') || '1h';
  const url = process.env.INFLUXDB_URL;
  const token = process.env.INFLUXDB_TOKEN;
  const org = process.env.INFLUXDB_ORG ?? '';
  const bucket = process.env.INFLUXDB_BUCKET ?? 'sensors';

  const result: Record<string, { times: string[]; values: number[] }> = {};
  for (const id of ALL_SENSOR_IDS) {
    result[id] = { times: [], values: [] };
  }

  if (!url || !token) {
    return NextResponse.json({ success: true, sensors: result });
  }

  const sensorIds = ALL_SENSOR_IDS;
  if (sensorIds.length === 0) {
    return NextResponse.json({ success: true, sensors: result });
  }

  const fluxFilter = sensorIds.map((id) => `r["sensor_id"] == "${id}"`).join(' or ');
  const flux = `
from(bucket: "${bucket}")
  |> range(start: -${range})
  |> filter(fn: (r) => ${fluxFilter})
  |> aggregateWindow(every: 2m, fn: mean, createEmpty: false)
  |> sort(columns: ["_time"])
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
      return NextResponse.json({ success: true, sensors: result });
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
        if (sensorId && result[sensorId] && !Number.isNaN(valueNum)) {
          result[sensorId].times.push(timeVal);
          result[sensorId].values.push(valueNum);
        }
      }
    }
  } catch {
    // ignore
  }

  return NextResponse.json({ success: true, sensors: result });
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
