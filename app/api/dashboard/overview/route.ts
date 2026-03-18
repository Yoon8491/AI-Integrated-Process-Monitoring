import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 대시보드 초기 로딩 시 summary, alerts, realtime, calendar-month 4개 API를
 * 서버에서 병렬로 한 번에 호출해 1회 응답으로 반환합니다.
 * 클라이언트는 1번의 HTTP 요청만 하면 되어 로딩이 빨라집니다.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const base =
      process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
      url.origin;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const [summaryRes, alertsRes, realtimeRes, calendarRes] = await Promise.all([
      fetch(`${base}/api/dashboard/summary`, { cache: 'no-store' }),
      fetch(`${base}/api/dashboard/alerts`, { cache: 'no-store' }),
      fetch(`${base}/api/dashboard/realtime`, { cache: 'no-store' }),
      fetch(`${base}/api/dashboard/calendar-month?year=${year}&month=${month}`, { cache: 'no-store' }),
    ]);

    const [summaryJson, alertsJson, realtimeJson, calendarJson] = await Promise.all([
      summaryRes.ok ? summaryRes.json() : { success: false },
      alertsRes.ok ? alertsRes.json() : { success: false, alerts: [] },
      realtimeRes.ok ? realtimeRes.json() : { success: false, sensors: [] },
      calendarRes.ok ? calendarRes.json() : { success: false, days: [] },
    ]);

    return NextResponse.json({
      success: true,
      summary: summaryJson,
      alerts: alertsJson,
      realtime: realtimeJson,
      calendar: calendarJson,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Dashboard overview error:', msg);
    return NextResponse.json(
      {
        success: false,
        error: msg,
        summary: { success: false, data: {}, fromDb: false, tables: [], usedTables: [] },
        alerts: { success: false, alerts: [] },
        realtime: { success: false, sensors: [] },
        calendar: { success: false, days: [] },
      },
      { status: 500 }
    );
  }
}
