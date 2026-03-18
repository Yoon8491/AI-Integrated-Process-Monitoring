import { NextRequest, NextResponse } from 'next/server';
import { getConnection } from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeJson(val: unknown): Record<string, unknown> {
  if (val == null) return {};
  if (typeof val === 'object') return val as Record<string, unknown>;
  if (typeof val === 'string') {
    try {
      return val.trim() ? (JSON.parse(val) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function formatDbTime(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(val.trim())) return val.trim();
  if (typeof val === 'string') return val.replace('T', ' ').slice(0, 19);
  const d = val as Date;
  if (typeof d.toISOString === 'function') {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0'), min = String(d.getMinutes()).padStart(2, '0'), sec = String(d.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}:${sec}`;
  }
  return String(val);
}

function rowToAlert(row: Record<string, unknown>) {
  const tsStr = formatDbTime(row.timestamp);
  const recStr = formatDbTime(row.received_at);
  return {
    id: row.id,
    status: row.status,
    alertname: row.alertname,
    grafana_folder: row.grafana_folder ?? undefined,
    host: row.host ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    labels: safeJson(row.labels),
    annotations: safeJson(row.annotations),
    values: safeJson(row.values),
    timestamp: tsStr,
    received_at: recStr,
  };
}

/** Grafana 최신 firing 알람 - 폴링/팝업용, latest_timestamp 반환 */
export async function GET(request: NextRequest) {
  const since = (request.nextUrl.searchParams.get('since') || '').trim();

  let conn;
  try {
    conn = await getConnection();
    const [rows] = since
      ? await conn.query<any[]>(
          `SELECT id, status, alertname, grafana_folder, host, title, description,
                  labels, annotations, \`values\`,
                  DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
                  DATE_FORMAT(received_at, '%Y-%m-%d %H:%i:%s') AS received_at
           FROM grafana_alerts
           WHERE status = 'firing' AND grafana_alerts.timestamp > ?
           ORDER BY grafana_alerts.timestamp DESC`,
          [since]
        )
      : await conn.query<any[]>(
          `SELECT id, status, alertname, grafana_folder, host, title, description,
                  labels, annotations, \`values\`,
                  DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
                  DATE_FORMAT(received_at, '%Y-%m-%d %H:%i:%s') AS received_at
           FROM grafana_alerts
           WHERE status = 'firing'
           ORDER BY grafana_alerts.timestamp DESC LIMIT 20`
        );

    const alerts = (rows || []).map(rowToAlert);
    let latestTimestamp: string | null = null;
    const [maxRow] = await conn.query<{ latest: string | null }[]>(
      "SELECT DATE_FORMAT(MAX(timestamp), '%Y-%m-%d %H:%i:%s') AS latest FROM grafana_alerts"
    );
    const max = Array.isArray(maxRow) ? maxRow[0] : null;
    if (max?.latest && String(max.latest).trim()) {
      latestTimestamp = String(max.latest).trim();
    }

    return NextResponse.json({
      success: true,
      alerts,
      latest_timestamp: latestTimestamp,
    });
  } catch (e) {
    console.warn('[grafana/alerts/latest] DB read failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({
      success: true,
      alerts: [],
      latest_timestamp: null,
    });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch {}
    }
  }
}
