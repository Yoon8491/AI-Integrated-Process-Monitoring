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

/** Grafana 알람 목록 - process DB의 grafana_alerts에서 직접 조회 (백엔드 없이 알람 내역·설비 이상 알림 표시) */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const limit = Math.min(Number(searchParams.get('limit')) || 20, 100);
  const status = searchParams.get('status') || null;

  let conn;
  try {
    conn = await getConnection();
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status, limit] : [limit];

    const [countRows] = await conn.query<{ total: number }[]>(
      `SELECT COUNT(*) as total FROM grafana_alerts ${where}`,
      status ? [status] : []
    );
    const total = (Array.isArray(countRows) ? countRows[0]?.total : 0) ?? 0;

    const [firingRows] = await conn.query<{ count: number }[]>(
      "SELECT COUNT(*) as count FROM grafana_alerts WHERE status = 'firing'"
    );
    const firing_count = (Array.isArray(firingRows) ? firingRows[0]?.count : 0) ?? 0;

    const [rows] = await conn.query<any[]>(
      `SELECT id, status, alertname, grafana_folder, host, title, description,
              labels, annotations, \`values\`,
              DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp,
              DATE_FORMAT(received_at, '%Y-%m-%d %H:%i:%s') AS received_at
       FROM grafana_alerts ${where}
       ORDER BY grafana_alerts.timestamp DESC LIMIT ?`,
      params
    );

    const alerts = (rows || []).map(rowToAlert);
    return NextResponse.json({
      success: true,
      alerts,
      total,
      firing_count,
    });
  } catch (e) {
    console.warn('[grafana/alerts] DB read failed (table may not exist):', e instanceof Error ? e.message : e);
    return NextResponse.json({
      success: true,
      alerts: [],
      total: 0,
      firing_count: 0,
    });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch {}
    }
  }
}
