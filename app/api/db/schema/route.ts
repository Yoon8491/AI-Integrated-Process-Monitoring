import { NextResponse } from 'next/server';
import mysql from 'mysql2/promise';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getConnConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  };
}

// 관리자 연결 풀 (데이터베이스 목록 조회용)
let adminPool: mysql.Pool | null = null;

function getAdminPool(): mysql.Pool {
  if (!adminPool) {
    adminPool = mysql.createPool({
      ...getConnConfig(),
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
    
    adminPool.on('error', (err) => {
      console.error('Admin DB pool error:', err);
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        adminPool = null; // 재생성하도록 설정
      }
    });
  }
  return adminPool;
}

// 데이터베이스별 연결 풀 (테이블 스키마 조회용)
const dbPools: Map<string, mysql.Pool> = new Map();

function getDbPool(dbName: string): mysql.Pool {
  if (!dbPools.has(dbName)) {
    const pool = mysql.createPool({
      ...getConnConfig(),
      database: dbName,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
    
    pool.on('error', (err) => {
      console.error(`DB pool error for ${dbName}:`, err);
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        dbPools.delete(dbName); // 재생성하도록 설정
      }
    });
    
    dbPools.set(dbName, pool);
  }
  return dbPools.get(dbName)!;
}

const SYSTEM_DATABASES = new Set([
  'information_schema',
  'mysql',
  'performance_schema',
  'sys',
]);

export async function GET(request: Request) {
  let adminConn: mysql.PoolConnection | null = null;
  let dbConn: mysql.PoolConnection | null = null;
  
  try {
    const url = new URL(request.url);
    const requestedDb = url.searchParams.get('db')?.trim();
    const defaultDbName = process.env.DB_NAME || 'manufacturing_db';

    // 1) DB 목록
    adminConn = await getAdminPool().getConnection();
    const [dbRows] = await adminConn.query<any[]>('SHOW DATABASES');
    const databasesAll = dbRows.map((r) => r.Database).filter(Boolean);
    const databases = databasesAll.filter((d) => !SYSTEM_DATABASES.has(String(d)));
    adminConn.release();
    adminConn = null;

    const dbName = requestedDb || defaultDbName;
    if (!databasesAll.includes(dbName)) {
      return NextResponse.json(
        {
          success: false,
          error: `요청한 데이터베이스를 찾을 수 없습니다: ${dbName}`,
          databases,
        },
        { status: 400 }
      );
    }

    // 2) 현재 DB의 테이블/컬럼
    dbConn = await getDbPool(dbName).getConnection();
    const [tableRows] = await dbConn.query<any[]>('SHOW TABLES');
    const tableNameKey = tableRows.length ? Object.keys(tableRows[0])[0] : null;
    const tables = tableNameKey ? tableRows.map((r) => r[tableNameKey]).filter(Boolean) : [];

    const tableSchemas: Record<
      string,
      Array<{ column: string; type: string; nullable: boolean; key: string | null; defaultValue: any }>
    > = {};

    for (const table of tables) {
      const [colRows] = await dbConn.query<any[]>(
        `SELECT COLUMN_NAME as columnName, COLUMN_TYPE as columnType, IS_NULLABLE as isNullable, COLUMN_KEY as columnKey, COLUMN_DEFAULT as columnDefault
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [dbName, table]
      );
      tableSchemas[table] = colRows.map((c) => ({
        column: c.columnName,
        type: c.columnType,
        nullable: String(c.isNullable).toUpperCase() === 'YES',
        key: c.columnKey || null,
        defaultValue: c.columnDefault,
      }));
    }

    dbConn.release();
    dbConn = null;

    return NextResponse.json({
      success: true,
      connected: {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || 'root',
        database: dbName,
      },
      databases,
      tables,
      schema: tableSchemas,
    });
  } catch (error: any) {
    console.error('DB schema introspection error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || String(error) },
      { status: 500 }
    );
  } finally {
    // 연결 정리
    if (adminConn) {
      try {
        adminConn.release();
      } catch (e) {
        console.error('Error releasing admin connection:', e);
      }
    }
    if (dbConn) {
      try {
        dbConn.release();
      } catch (e) {
        console.error('Error releasing db connection:', e);
      }
    }
  }
}

