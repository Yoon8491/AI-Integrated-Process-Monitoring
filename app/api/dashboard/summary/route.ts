import { NextResponse } from 'next/server';
import {
  getConnection,
  getTables,
  getProcessDataTable,
  getProcessColumnMap,
} from '@/lib/dashboard-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  let conn;
  try {
    conn = await getConnection();
    const tables = await getTables(conn);
    const processTable = await getProcessDataTable(conn);
    if (!processTable) {
      conn.release();
      conn = null;
      return NextResponse.json({
        success: true,
        data: {},
        fromDb: false,
        tables,
        usedTables: [],
        columnMap: null,
      });
    }

    const map = await getProcessColumnMap(conn, processTable);
    const { table, dateCol, quantityCol, passRateCol, consumptionCol, efficiencyCol } = map;

    let productionToday: number | null = null;
    let equipmentRate: number | null = null;
    let qualityRate: number | null = null;
    let energyToday: number | null = null;
    const usedTables: string[] = [processTable];

    const dateCondition = dateCol ? `WHERE DATE(\`${dateCol}\`) = CURDATE()` : '';
    const dateCondition1d = dateCol ? `WHERE \`${dateCol}\` >= DATE_SUB(CURDATE(), INTERVAL 1 DAY)` : '';

    if (quantityCol && dateCol) {
      const [rows] = await conn.query<any[]>(
        `SELECT COALESCE(SUM(\`${quantityCol}\`), 0) as total FROM \`${table}\` ${dateCondition}`
      );
      productionToday = Number(rows?.[0]?.total ?? 0);
    }

    if (efficiencyCol && dateCol) {
      const [rows] = await conn.query<any[]>(
        `SELECT AVG(\`${efficiencyCol}\`) as avg_rate FROM \`${table}\` ${dateCondition1d}`
      );
      const v = rows?.[0]?.avg_rate;
      equipmentRate = v != null ? Number(v) : null;
    }

    if (passRateCol && dateCol) {
      const [rows] = await conn.query<any[]>(
        `SELECT AVG(\`${passRateCol}\`) as avg_rate FROM \`${table}\` ${dateCondition1d}`
      );
      const v = rows?.[0]?.avg_rate;
      qualityRate = v != null ? Number(v) : null;
    }

    if (consumptionCol && dateCol) {
      const [rows] = await conn.query<any[]>(
        `SELECT COALESCE(SUM(\`${consumptionCol}\`), 0) as total FROM \`${table}\` ${dateCondition}`
      );
      energyToday = Number(rows?.[0]?.total ?? 0);
    }

    const fromDb =
      productionToday != null ||
      equipmentRate != null ||
      qualityRate != null ||
      energyToday != null;

    conn.release();
    conn = null;

    return NextResponse.json({
      success: true,
      data: {
        productionToday: productionToday ?? undefined,
        equipmentRate: equipmentRate ?? undefined,
        qualityRate: qualityRate ?? undefined,
        energyToday: energyToday ?? undefined,
      },
      fromDb,
      tables,
      usedTables: fromDb ? usedTables : [],
      columnMap: fromDb ? map : null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Dashboard summary error:', msg);
    return NextResponse.json(
      { success: false, error: msg, data: {}, fromDb: false, tables: [], usedTables: [], columnMap: null },
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
