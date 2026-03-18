import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Grafana/Prometheus API 응답의 개별 알람 구조 */
type RawAlert = {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  state?: string;
  activeAt?: string;
  startsAt?: string;
  value?: string;
  fingerprint?: string;
  [key: string]: unknown;
};

/** UI에 맞는 변환된 알람 형식 */
export type MappedAlert = {
  id: string;
  title: string;
  timestamp: string;
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  host?: string;
  grafana_folder?: string;
};

function mapGrafanaAlertToUi(raw: RawAlert): MappedAlert {
  const labels = raw.labels ?? {};
  const annotations = raw.annotations ?? {};
  const activeAt = raw.activeAt ?? raw.startsAt ?? '';
  const alertname = labels.alertname ?? annotations.summary ?? '알람';
  const id = raw.fingerprint ?? `${alertname}-${activeAt}`;

  return {
    id: String(id),
    title: String(alertname),
    timestamp: activeAt,
    labels,
    annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
    host: labels.host ?? labels.instance,
    grafana_folder: labels.grafana_folder ?? labels.folder,
  };
}

/**
 * Grafana API (GET /api/prometheus/grafana/api/v1/alerts) 호출
 * - state === 'firing' 인 활성 알람만 반환
 * - GRAFANA_URL, GRAFANA_TOKEN 환경 변수 사용
 */
export async function GET() {
  const grafanaUrl = process.env.GRAFANA_URL?.replace(/\/$/, '');
  const grafanaToken = process.env.GRAFANA_TOKEN;

  if (!grafanaUrl) {
    return NextResponse.json(
      { success: false, alerts: [], error: 'GRAFANA_URL not configured' },
      { status: 200 }
    );
  }

  const url = `${grafanaUrl}/api/prometheus/grafana/api/v1/alerts`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (grafanaToken) {
    headers['Authorization'] = `Bearer ${grafanaToken}`;
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn('[api/alerts] Grafana API error:', res.status, text);
      return NextResponse.json({
        success: false,
        alerts: [],
        error: `Grafana API returned ${res.status}`,
      });
    }

    const data = await res.json();
    const rawAlerts: RawAlert[] =
      Array.isArray(data?.data?.alerts)
        ? data.data.alerts
        : Array.isArray(data?.alerts)
          ? data.alerts
          : [];

    const firingOnly = rawAlerts.filter(
      (a) => String(a.state ?? '').toLowerCase() === 'firing'
    );
    const mapped: MappedAlert[] = firingOnly.map(mapGrafanaAlertToUi);

    return NextResponse.json({
      success: true,
      alerts: mapped,
    });
  } catch (e) {
    console.error('[api/alerts] Grafana fetch failed:', e);
    return NextResponse.json({
      success: false,
      alerts: [],
      error: e instanceof Error ? e.message : 'Unknown error',
    });
  }
}
