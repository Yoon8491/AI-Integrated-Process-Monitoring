import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log('✅ .env 파일 로드됨:', envPath);
} else {
  console.log('⚠️ .env 파일 없음');
}

import { config } from '../src/config.js';

console.log('\n=== 현재 DB 설정 ===\n');
console.log('Auth DB:');
console.log(`  Host: ${config.db.host}`);
console.log(`  Port: ${config.db.port}`);
console.log(`  User: ${config.db.user}`);
console.log(`  Database: ${config.db.database}`);
console.log(`  Password: ${config.db.password ? '***설정됨***' : '(없음)'}`);

console.log('\nProcess DB:');
console.log(`  Host: ${config.processDb.host}`);
console.log(`  Port: ${config.processDb.port}`);
console.log(`  User: ${config.processDb.user}`);
console.log(`  Database: ${config.processDb.database}`);
console.log(`  Password: ${config.processDb.password ? '***설정됨***' : '(없음)'}`);

console.log('\n=== 환경변수 직접 확인 ===\n');
console.log(`DB_HOST: ${process.env.DB_HOST || '(없음)'}`);
console.log(`DB_PORT: ${process.env.DB_PORT || '(없음)'}`);
console.log(`DB_USER: ${process.env.DB_USER || '(없음)'}`);
console.log(`DB_NAME: ${process.env.DB_NAME || '(없음)'}`);
console.log(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? '***설정됨***' : '(없음)'}`);
