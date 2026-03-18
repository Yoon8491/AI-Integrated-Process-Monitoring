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

async function checkTables() {
  try {
    console.log('=== simulation_defects_only 테이블 구조 ===\n');
    const structure1 = await authQuery<any[]>('DESCRIBE simulation_defects_only');
    console.table(structure1);
    
    console.log('\n=== simulation_defects_only 샘플 데이터 (prediction=1) ===\n');
    const sample1 = await authQuery<any[]>(
      'SELECT * FROM simulation_defects_only WHERE prediction = 1 LIMIT 3'
    );
    console.table(sample1);
    
    console.log('\n=== lot_defect_reports 테이블 구조 ===\n');
    const structure2 = await authQuery<any[]>('DESCRIBE lot_defect_reports');
    console.table(structure2);
    
    console.log('\n=== 불량 LOT 개수 확인 ===\n');
    const count = await authQuery<any[]>(
      'SELECT COUNT(DISTINCT lot_id) as total_defect_lots FROM simulation_defects_only WHERE prediction = 1'
    );
    console.table(count);
    
  } catch (error) {
    console.error('오류:', error);
  }
}

checkTables();
