import { NextResponse } from 'next/server';
import {
  getConnection,
  getTables,
  getColumns,
  escapeSqlId,
  isSafeColumnName,
} from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_AGGS = ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'];
const DEFAULT_LIMIT = 50; // 처음 화면: 최근 50개
const MAX_ROWS_PERIOD = 10000; // 기간 선택 시: 해당 기간 내 전체 (상한)
const DATE_RANGES = ['7d', '30d', '3m', '1y', 'all'] as const;

/** 차트 데이터 동적 쿼리. SQL 인젝션 방지 위해 화이트리스트 검증 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      table,
      xColumn,
      xTimeGrain,
      metricFn,
      metricColumn,
      limit: limitParam,
      dateRange,
    } = body as {
      table?: string;
      xColumn?: string;
      xTimeGrain?: 'raw' | 'hour' | 'day' | 'month';
      metricFn?: string;
      metricColumn?: string;
      limit?: number;
      dateRange?: '7d' | '30d' | '3m' | '1y' | 'all';
    };

    /** 기간 선택 시: 해당 기간 내 전체 데이터. 'all'일 때만 50개 제한 */
    const validDateRange = dateRange && DATE_RANGES.includes(dateRange) && dateRange !== 'all';
    const limit = validDateRange
      ? MAX_ROWS_PERIOD
      : Math.min(Math.max(1, Number(limitParam) || DEFAULT_LIMIT), DEFAULT_LIMIT);

    if (!table || !xColumn) {
      return NextResponse.json(
        { success: false, error: 'table, xColumn 필수' },
        { status: 400 }
      );
    }

    if (!isSafeColumnName(table) || !isSafeColumnName(xColumn)) {
      return NextResponse.json(
        { success: false, error: '잘못된 테이블/컬럼명' },
        { status: 400 }
      );
    }

    const conn = await getConnection();
    try {
      const tables = await getTables(conn);
      if (!tables.map((t) => t.toLowerCase()).includes(table.toLowerCase())) {
        return NextResponse.json(
          { success: false, error: `테이블 없음: ${table}` },
          { status: 400 }
        );
      }

      const columns = await getColumns(conn, table);
      const colNames = columns.map((c) => c.name);
      const xColValid = colNames.some(
        (c) => c.toLowerCase() === xColumn.toLowerCase()
      );
      if (!xColValid) {
        return NextResponse.json(
          { success: false, error: `X축 컬럼 없음: ${xColumn}` },
          { status: 400 }
        );
      }

      const agg = String(metricFn || 'COUNT').toUpperCase();
      if (!ALLOWED_AGGS.includes(agg)) {
        return NextResponse.json(
          { success: false, error: `허용되지 않은 집계: ${agg}` },
          { status: 400 }
        );
      }

      const metricCol = metricColumn?.trim();
      let selectX: string;
      const xColEsc = escapeSqlId(xColumn);

      const dateCol = columns.find(
        (c) =>
          /timestamp|date|time|created|recorded/i.test(c.name) ||
          /date|time|datetime/i.test(c.type)
      );

      if (
        xTimeGrain &&
        xTimeGrain !== 'raw' &&
        dateCol &&
        dateCol.name.toLowerCase() === xColumn.toLowerCase()
      ) {
        const dateColEsc = escapeSqlId(dateCol.name);
        if (xTimeGrain === 'day') {
          selectX = `DATE(${dateColEsc})`;
        } else if (xTimeGrain === 'hour') {
          selectX = `DATE_FORMAT(${dateColEsc}, '%Y-%m-%d %H:00')`;
        } else if (xTimeGrain === 'month') {
          selectX = `DATE_FORMAT(${dateColEsc}, '%Y-%m')`;
        } else {
          selectX = dateColEsc;
        }
      } else {
        selectX = xColEsc;
      }

      let selectY: string;
      if (agg === 'COUNT' && !metricCol) {
        selectY = 'COUNT(*)';
      } else if (metricCol && isSafeColumnName(metricCol)) {
        const metricColValid = colNames.some(
          (c) => c.toLowerCase() === metricCol.toLowerCase()
        );
        if (!metricColValid) {
          return NextResponse.json(
            { success: false, error: `Y축 컬럼 없음: ${metricCol}` },
            { status: 400 }
          );
        }
        const metricColEsc = escapeSqlId(metricCol);
        selectY = `${agg}(${metricColEsc})`;
      } else {
        selectY = 'COUNT(*)';
      }

      const tableEsc = escapeSqlId(table);
      let whereClause = '';
      if (validDateRange && dateCol) {
        const dateColEsc = escapeSqlId(dateCol.name);
        const intervalMap = { '7d': '7 DAY', '30d': '30 DAY', '3m': '3 MONTH', '1y': '1 YEAR' } as const;
        whereClause = ` WHERE ${dateColEsc} >= DATE_SUB(NOW(), INTERVAL ${intervalMap[dateRange]})`;
      }
      const sql = `SELECT ${selectX} as x_val, ${selectY} as y_val FROM ${tableEsc}${whereClause} GROUP BY ${selectX} ORDER BY ${selectX} ASC LIMIT ${limit}`;

      const [rows] = await conn.query<any[]>(sql);
      const data = (rows || []).map((r) => ({
        x: r.x_val instanceof Date ? r.x_val.toISOString() : String(r.x_val ?? ''),
        y: Number(r.y_val) ?? 0,
      }));

      return NextResponse.json({
        success: true,
        data,
        rowCount: data.length,
      });
    } finally {
      conn.release();
    }
  } catch (error: unknown) {
    console.error('Chart explorer query error:', error);
    return NextResponse.json(
      { success: false, error: String((error as Error).message) },
      { status: 500 }
    );
  }
}
