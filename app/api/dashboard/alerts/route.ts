import { NextResponse } from 'next/server';
import {
  getConnection,
  getProcessDataTable,
  getColumns,
} from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGMA_MULTIPLIER = 3; // 관리선: 평균 ± 3σ
const RECENT_LIMIT = 100; // 최근 N개 데이터로 통계 계산

type Alert = {
  column: string;
  columnKorean: string;
  currentValue: number;
  mean: number;
  stdDev: number;
  upperLimit: number;
  lowerLimit: number;
  deviation: number; // 관리선 이탈 정도 (σ 단위)
  severity: 'warning' | 'critical'; // warning: 2-3σ, critical: >3σ
};

/** 컬럼명을 한국어로 변환 (간단 버전) */
function columnToKorean(col: string): string {
  const dict: Record<string, string> = {
    temperature: '온도',
    temp: '온도',
    humidity: '습도',
    pressure: '압력',
    voltage: '전압',
    current: '전류',
    power: '전력',
    energy: '에너지',
    speed: '속도',
    weight: '무게',
    thickness: '두께',
    density: '밀도',
    flow: '유량',
    lithium_input: '리튬 투입량',
    cobalt_input: '코발트 투입량',
    nickel_input: '니켈 투입량',
  };
  
  const lower = col.toLowerCase();
  for (const [en, ko] of Object.entries(dict)) {
    if (lower.includes(en)) return ko;
  }
  
  return col;
}

export async function GET() {
  let conn;
  try {
    conn = await getConnection();
    const tableName = await getProcessDataTable(conn);
    if (!tableName) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        alerts: [],
        message: 'NO_TABLE',
      });
    }

    const columns = await getColumns(conn, tableName);
    const numericCols = columns
      .filter((c) => /int|decimal|float|double/i.test(c.type))
      .map((c) => c.name);

    if (numericCols.length === 0) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        alerts: [],
        message: 'NO_NUMERIC_COLUMNS',
      });
    }

    // 날짜 컬럼 찾기
    const dateCol = columns.find((c) =>
      /date|time|created|recorded/i.test(c.name) || /date|time/i.test(c.type)
    )?.name;

    const orderBy = dateCol ? `ORDER BY \`${dateCol}\` DESC` : '';
    const colList = numericCols.map((c) => `\`${c}\``).join(', ');

    // 최근 데이터 조회
    const [rows]: any = await conn.query(
      `SELECT ${colList} FROM \`${tableName}\` ${orderBy} LIMIT ${RECENT_LIMIT}`
    );

    if (!rows || rows.length < 10) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        alerts: [],
        message: 'INSUFFICIENT_DATA',
      });
    }

    const alerts: Alert[] = [];

    // 각 컬럼별 통계 계산 및 이상 감지
    for (const col of numericCols) {
      const values = rows
        .map((r: any) => r[col])
        .filter((v: any) => v != null && !Number.isNaN(Number(v)))
        .map((v: any) => Number(v));

      if (values.length < 10) continue;

      // 통계 계산
      const mean = values.reduce((a: number, b: number) => a + b, 0) / values.length;
      const variance = values.reduce((a: number, b: number) => a + Math.pow(b - mean, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev === 0) continue; // 표준편차 0이면 스킵

      const upperLimit = mean + SIGMA_MULTIPLIER * stdDev;
      const lowerLimit = mean - SIGMA_MULTIPLIER * stdDev;

      // 최근 값 (첫 번째 행)
      const currentValue = values[0];
      
      // 관리선 이탈 확인
      if (currentValue > upperLimit || currentValue < lowerLimit) {
        const deviation = Math.abs((currentValue - mean) / stdDev);
        const severity = deviation > 3 ? 'critical' : 'warning';

        alerts.push({
          column: col,
          columnKorean: columnToKorean(col),
          currentValue,
          mean,
          stdDev,
          upperLimit,
          lowerLimit,
          deviation,
          severity,
        });
      }
    }

    // 심각도 순으로 정렬 (critical > warning, deviation 높은 순)
    alerts.sort((a, b) => {
      if (a.severity === 'critical' && b.severity !== 'critical') return -1;
      if (a.severity !== 'critical' && b.severity === 'critical') return 1;
      return b.deviation - a.deviation;
    });

    conn.release();
    conn = null;

    return NextResponse.json({
      success: true,
      alerts,
      totalAlerts: alerts.length,
      criticalCount: alerts.filter((a) => a.severity === 'critical').length,
      warningCount: alerts.filter((a) => a.severity === 'warning').length,
      dataPoints: rows.length,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Alerts API error:', msg);
    return NextResponse.json(
      {
        success: false,
        error: msg,
        alerts: [],
      },
      { status: 500 }
    );
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (e) {
        console.error('Error releasing connection:', e);
      }
    }
  }
}
