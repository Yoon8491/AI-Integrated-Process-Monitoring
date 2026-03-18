import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

import { authQuery } from '../src/db.js';

async function checkDuplicateLots() {
  try {
    // 1. 중복된 lot_id 찾기
    console.log('=== 중복된 lot_id 확인 ===\n');
    const duplicates = await authQuery<any[]>(
      `SELECT lot_id, COUNT(*) as count 
       FROM lot_defect_reports 
       GROUP BY lot_id 
       HAVING COUNT(*) > 1 
       ORDER BY count DESC 
       LIMIT 10`
    );
    
    if (duplicates.length === 0) {
      console.log('✅ 중복된 lot_id가 없습니다!');
      
      // 전체 레코드 수 확인
      const total = await authQuery<any[]>(
        `SELECT COUNT(*) as total, COUNT(DISTINCT lot_id) as unique_lots 
         FROM lot_defect_reports`
      );
      console.log('\n전체 통계:');
      console.table(total);
      
    } else {
      console.log('❌ 중복된 lot_id 발견:');
      console.table(duplicates);
      
      // 첫 번째 중복 LOT의 상세 정보
      const firstDup = duplicates[0].lot_id;
      console.log(`\n=== LOT "${firstDup}"의 모든 레코드 ===\n`);
      const details = await authQuery<any[]>(
        `SELECT id, lot_id, 
                LEFT(report_content, 100) as report_preview,
                timestamp 
         FROM lot_defect_reports 
         WHERE lot_id = ? 
         ORDER BY timestamp`,
        [firstDup]
      );
      console.table(details);
    }
    
    // 2. 테이블 제약 조건 확인
    console.log('\n=== lot_defect_reports 테이블 구조 ===\n');
    const schema = await authQuery<any[]>(
      `SHOW CREATE TABLE lot_defect_reports`
    );
    console.log(schema[0]['Create Table']);
    
  } catch (error) {
    console.error('오류:', error);
  }
}

checkDuplicateLots();
