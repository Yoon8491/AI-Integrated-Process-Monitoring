import { NextResponse } from 'next/server';
import {
  getConnection,
  getTables,
  getProcessDataTable,
  getColumns,
} from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 차트 빌더용 테이블·컬럼 스키마 조회 */
export async function GET() {
  try {
    const conn = await getConnection();
    try {
      const tables = await getTables(conn);
      const processTable = await getProcessDataTable(conn);
      const tableToUse = processTable || tables[0] || 'simulation_results';

      if (!tables.includes(tableToUse)) {
        return NextResponse.json(
          { success: false, error: `테이블을 찾을 수 없습니다: ${tableToUse}` },
          { status: 400 }
        );
      }

      const columns = await getColumns(conn, tableToUse);
      const dateCols = columns.filter((c) =>
        /date|time|timestamp|created|recorded/i.test(c.name) || /date|time|datetime/i.test(c.type)
      );
      const numericCols = columns.filter((c) =>
        /int|decimal|float|double|bigint/i.test(c.type)
      );

      return NextResponse.json({
        success: true,
        table: tableToUse,
        tables,
        columns: columns.map((c) => ({ name: c.name, type: c.type })),
        dateColumns: dateCols.map((c) => c.name),
        numericColumns: numericCols.map((c) => c.name),
      });
    } finally {
      conn.release();
    }
  } catch (error: unknown) {
    console.error('Chart explorer schema error:', error);
    return NextResponse.json(
      { success: false, error: String((error as Error).message) },
      { status: 500 }
    );
  }
}
