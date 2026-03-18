import { NextResponse } from 'next/server';
import {
  getConnection,
  getProcessColumnMap,
  getColumns,
  escapeSqlId,
} from '@/lib/dashboard-db';
import { ALL_SENSOR_IDS } from '@/lib/influxdb-sensors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 품질 데이터용 테이블 (MariaDB) */
const QUALITY_TABLE = 'simulation_results';

/** 품질 CSV 내보내기 컬럼 (존재하는 것만 선택) */
const QUALITY_EXPORT_COLUMNS = [
  'timestamp',
  'lot_id',
  'lithium_input',
  'additive_ratio',
  'process_time',
  'humidity',
  'tank_pressure',
  'sintering_temp',
  'metal_impurity',
  'd50',
  'prediction',
];

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

/** InfluxDB 설비 데이터 CSV 내보내기 */
async function exportEquipmentInfluxDb(
  startDate: string,
  endDate: string,
  startTime: string,
  endTime: string,
  paramsParam: string,
  escapeCsvCell: (v: unknown) => string
): Promise<NextResponse> {
  const url = process.env.INFLUXDB_URL;
  const token = process.env.INFLUXDB_TOKEN;
  const org = process.env.INFLUXDB_ORG ?? '';
  const bucket = process.env.INFLUXDB_BUCKET ?? 'sensors';

  if (!url || !token) {
    return NextResponse.json(
      { success: false, error: 'InfluxDB not configured (INFLUXDB_URL, INFLUXDB_TOKEN)' },
      { status: 503 }
    );
  }

  const requestedIds = paramsParam ? paramsParam.split(',').map((p) => p.trim()).filter(Boolean) : [];
  const sensorIds = requestedIds.length > 0
    ? requestedIds.filter((id) => ALL_SENSOR_IDS.includes(id))
    : ALL_SENSOR_IDS;

  if (sensorIds.length === 0) {
    return NextResponse.json({ success: false, error: 'No valid sensor IDs to export' }, { status: 400 });
  }

  const tz = process.env.BACKEND_DATE_TZ || 'Asia/Seoul';
  const useKst = /Asia\/Seoul|KST|Korea/i.test(tz);
  const startStr = useKst ? `${startDate}T${startTime}:00+09:00` : `${startDate}T${startTime}:00`;
  const stopStr = useKst ? `${endDate}T${endTime}:59.999+09:00` : `${endDate}T${endTime}:59.999`;
  const startIso = new Date(startStr).toISOString();
  const stopIso = new Date(stopStr).toISOString();

  const fluxFilter = sensorIds.map((id) => `r["sensor_id"] == "${id}"`).join(' or ');
  const flux = `
from(bucket: "${bucket}")
  |> range(start: ${startIso}, stop: ${stopIso})
  |> filter(fn: (r) => ${fluxFilter})
  |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
  |> sort(columns: ["_time"])
`.trim();

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/v2/query?org=${encodeURIComponent(org)}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/vnd.flux',
        Accept: 'application/csv',
      },
      body: flux,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[export] InfluxDB error:', res.status, text);
      return NextResponse.json({ success: false, error: `InfluxDB query failed: ${res.statusText}` }, { status: 502 });
    }

    const csv = await res.text();
    const lines = csv.split('\n').filter((l) => l.trim());
    if (lines.length < 2) {
      const emptyCsv = '\uFEFFtimestamp,sensor_id,value\n';
      return new NextResponse(emptyCsv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="equipment_${startDate}_${endDate}.csv"`,
        },
      });
    }

    const header = lines[0].split(',');
    const timeIdx = header.findIndex((h) => h === '_time');
    const valueIdx = header.findIndex((h) => h === '_value');
    const sensorIdCol = header.findIndex((h) => h === 'sensor_id');

    const byTime = new Map<string, Record<string, number>>();
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]);
      const sensorId = sensorIdCol >= 0 ? parts[sensorIdCol]?.trim() : '';
      const timeVal = timeIdx >= 0 ? parts[timeIdx]?.trim() : '';
      const valueNum = valueIdx >= 0 ? parseFloat(parts[valueIdx]) : NaN;
      if (!sensorId || !timeVal || Number.isNaN(valueNum)) continue;

      if (!byTime.has(timeVal)) byTime.set(timeVal, {});
      byTime.get(timeVal)![sensorId] = valueNum;
    }

    const sortedTimes = [...byTime.keys()].sort();
    const headers = ['timestamp', ...sensorIds];
    const csvRows = [headers.map(escapeCsvCell).join(',')];
    for (const t of sortedTimes) {
      const row = byTime.get(t)!;
      const values = [escapeCsvCell(t)];
      for (const id of sensorIds) {
        values.push(escapeCsvCell(row[id] ?? ''));
      }
      csvRows.push(values.join(','));
    }

    const out = '\uFEFF' + csvRows.join('\n');
    return new NextResponse(out, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="equipment_${startDate}_${endDate}.csv"`,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[export] InfluxDB error:', msg);
    const friendlyMsg =
      /fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(msg)
        ? 'InfluxDB 연결 실패. InfluxDB가 실행 중인지 확인해 주세요. (localhost:8086)'
        : msg;
    return NextResponse.json({ success: false, error: friendlyMsg }, { status: 500 });
  }
}

/** CSV 행 escape (쉼표, 줄바꿈, 따옴표 처리) */
function escapeCsvCell(val: unknown): string {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') as 'quality' | 'equipment' | null;
  const listParams = searchParams.get('listParams') === '1';
  const startDate = searchParams.get('startDate') || '';
  const endDate = searchParams.get('endDate') || startDate;
  const startTime = searchParams.get('startTime') || '00:00';
  const endTime = searchParams.get('endTime') || '23:59';
  const paramsParam = searchParams.get('params') || '';

  if (!type || (type !== 'quality' && type !== 'equipment')) {
    return NextResponse.json({ success: false, error: 'type must be quality or equipment' }, { status: 400 });
  }

  const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  if (listParams && type === 'equipment') {
    return NextResponse.json({ success: true, params: ALL_SENSOR_IDS });
  }

  if (!validDate(startDate) || !validDate(endDate)) {
    return NextResponse.json({ success: false, error: 'startDate and endDate required (YYYY-MM-DD)' }, { status: 400 });
  }

  if (type === 'equipment') {
    return exportEquipmentInfluxDb(startDate, endDate, startTime, endTime, paramsParam, escapeCsvCell);
  }

  let conn;
  try {
    conn = await getConnection();
    const map = await getProcessColumnMap(conn, QUALITY_TABLE);
    const columns = await getColumns(conn, QUALITY_TABLE);
    const dateCol = map.dateCol || columns.find((c) => /date|time|created|recorded/i.test(c.name))?.name;
    const numericCols = columns.filter((c) => /int|decimal|float|double/i.test(c.type)).map((c) => c.name);

    if (!dateCol) {
      conn.release();
      return NextResponse.json({ success: false, error: 'No date column found in simulation_results' }, { status: 500 });
    }

    const dateFrom = `${startDate} ${startTime}:00`;
    const dateTo = `${endDate} ${endTime}:59`;

    if (type === 'quality') {
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '_');
      const selectCols: string[] = [];
      for (const want of QUALITY_EXPORT_COLUMNS) {
        const exact = columns.find((c) => norm(c.name) === norm(want));
        const partial = columns.find((c) => norm(c.name).includes(norm(want)) || norm(want).includes(norm(c.name)));
        const colName = exact?.name ?? partial?.name;
        if (colName) selectCols.push(colName);
      }
      if (selectCols.length === 0) {
        conn.release();
        return NextResponse.json({ success: false, error: 'No matching columns found in simulation_results' }, { status: 500 });
      }
      const colList = selectCols.map((c) => escapeSqlId(c)).join(', ');
      const [rows]: any = await conn.query(
        `SELECT ${colList}
         FROM ${escapeSqlId(QUALITY_TABLE)}
         WHERE ${escapeSqlId(dateCol)} >= ? AND ${escapeSqlId(dateCol)} <= ?
         ORDER BY ${escapeSqlId(dateCol)} ASC
         LIMIT 50000`,
        [dateFrom, dateTo]
      );

      const data = rows || [];
      const headers = selectCols;
      const csvRows = [headers.map(escapeCsvCell).join(',')];
      for (const r of data) {
        const values = headers.map((h) => {
          const v = r[h];
          if (v instanceof Date) return escapeCsvCell(v.toISOString());
          return escapeCsvCell(v);
        });
        csvRows.push(values.join(','));
      }

      conn.release();
      const csv = '\uFEFF' + csvRows.join('\n');
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="quality_${startDate}_${endDate}.csv"`,
        },
      });
    }

    conn.release();
    return NextResponse.json({ success: false, error: 'Invalid type' }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[export] Error:', msg);
    if (conn) try { conn.release(); } catch {}
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
