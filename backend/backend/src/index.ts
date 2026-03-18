import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDashboardSummary } from './routes/dashboard/summary.js';
import { registerDashboardAlerts } from './routes/dashboard/alerts.js';
import { registerDashboardRealtime } from './routes/dashboard/realtime.js';
import { registerDashboardCalendarMonth } from './routes/dashboard/calendar-month.js';
import { registerDashboardAnalytics } from './routes/dashboard/analytics.js';
import { registerDashboardLotStatus } from './routes/dashboard/lot-status.js';
import { registerLotStatusDateRange } from './routes/dashboard/lot-status-date-range.js';
import { registerLotStatusDatesInMonth } from './routes/dashboard/lot-status-dates-in-month.js';
import { registerDashboardLotDefectReport } from './routes/dashboard/lot-defect-report.js';
import { registerNewsRoutes } from './routes/news.js';
import { registerChatRoutes } from './routes/chat.js';

const app = Fastify({
  logger: true,
});

await app.register(cors, {
  origin: (origin, cb) => {
    // non-browser clients (curl, server-to-server) - origin이 없으면 허용
    if (!origin) {
      console.log('[CORS] No origin (non-browser request), allowing');
      return cb(null, true);
    }
    
    const allowed = new Set(
      config.corsOrigin
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    
    // Vercel 도메인도 허용 (와일드카드 패턴 지원)
    const isVercelDomain = origin.includes('.vercel.app');
    
    // 같은 호스트의 다른 포트도 허용 (개발 환경)
    const sameHost = origin.includes('3.34.166.82') || origin.includes('localhost') || origin.includes('127.0.0.1');
    
    const isAllowed = allowed.has(origin) || isVercelDomain || sameHost;
    
    console.log('[CORS] Origin check:', { 
      origin, 
      isAllowed, 
      allowed: Array.from(allowed),
      isVercelDomain,
      sameHost
    });
    
    cb(null, isAllowed);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  preflightContinue: false,
});

app.get('/health', async () => ({ ok: true }));

await registerAuthRoutes(app);
await registerDashboardSummary(app);
await registerDashboardAlerts(app);
await registerDashboardRealtime(app);
await registerDashboardCalendarMonth(app);
await registerDashboardAnalytics(app);
await registerDashboardLotStatus(app);
await registerLotStatusDateRange(app);
await registerLotStatusDatesInMonth(app);
await registerDashboardLotDefectReport(app);
await registerNewsRoutes(app);
await registerChatRoutes(app);

await app.listen({ port: config.port, host: '0.0.0.0' });

