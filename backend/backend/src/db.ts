import mysql from 'mysql2/promise';
import { config } from './config.js';

let authPool: mysql.Pool | null = null;
let processPool: mysql.Pool | null = null;

export function getAuthPool(): mysql.Pool {
  if (!authPool) {
    authPool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
    
    authPool.on('error', (err) => {
      console.error('Auth DB pool error:', err);
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        authPool = null; // 재생성하도록 설정
      }
    });
  }
  return authPool;
}

export function getProcessPool(): mysql.Pool {
  if (!processPool) {
    processPool = mysql.createPool({
      host: config.processDb.host,
      port: config.processDb.port,
      user: config.processDb.user,
      password: config.processDb.password,
      database: config.processDb.database,
      connectTimeout: 10000,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
    
    processPool.on('error', (err) => {
      console.error('Process DB pool error:', err);
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        processPool = null; // 재생성하도록 설정
      }
    });
  }
  return processPool;
}

export async function authQuery<T = unknown>(
  sql: string,
  params?: any[]
): Promise<T> {
  const pool = getAuthPool();
  const [results] = await pool.execute(sql, params);
  return results as T;
}

export async function getProcessConnection(): Promise<mysql.PoolConnection> {
  const pool = getProcessPool();
  return pool.getConnection();
}

