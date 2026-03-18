import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || 'https://azas-project.vercel.app',
  jwtSecret:
    process.env.JWT_SECRET || 'manufacturing-dashboard-secret-change-in-production',
  db: {
    // Auth DB (users table)
    host: process.env.AUTH_DB_HOST || process.env.DB_HOST || 'localhost',
    port: Number(process.env.AUTH_DB_PORT || process.env.DB_PORT || 3306),
    user: process.env.AUTH_DB_USER || process.env.DB_USER || 'root',
    password: process.env.AUTH_DB_PASSWORD ?? process.env.DB_PASSWORD ?? '',
    database:
      process.env.AUTH_DB_NAME ||
      process.env.DB_NAME ||
      'project',
  },
  processDb: {
    // 공정/대시보드 DB (project DB: simulation_results 테이블의 prediction 컬럼 사용)
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.PROCESS_DB_NAME || process.env.DB_NAME || 'project',
  },
};

