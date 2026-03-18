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

async function reorderDefectReports() {
  try {
    console.log('🔄 lot_defect_reports 테이블 재정렬 시작...\n');
    
    // 1. 기존 데이터를 timestamp 순으로 모두 가져오기
    console.log('📊 기존 데이터 조회 중...');
    const existingReports = await authQuery<any[]>(
      `SELECT id, lot_id, report_content, lot_data_json, timestamp
       FROM lot_defect_reports
       ORDER BY timestamp ASC`
    );
    
    console.log(`✅ 총 ${existingReports.length}개의 리포트 발견\n`);
    
    if (existingReports.length === 0) {
      console.log('⚠️ 재정렬할 데이터가 없습니다.');
      return;
    }
    
    // 2. 기존 테이블 비우기
    console.log('🗑️  기존 데이터 임시 삭제 중...');
    await authQuery('DELETE FROM lot_defect_reports');
    console.log('✅ 삭제 완료\n');
    
    // 3. ID를 1번부터 다시 매기면서 삽입
    console.log('💾 날짜 순서대로 재삽입 중...\n');
    
    for (let i = 0; i < existingReports.length; i++) {
      const report = existingReports[i];
      const newId = i + 1; // 1번부터 시작
      
      await authQuery(
        `INSERT INTO lot_defect_reports 
          (id, lot_id, report_content, lot_data_json, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
        [
          newId,
          report.lot_id,
          report.report_content,
          report.lot_data_json,
          report.timestamp
        ]
      );
      
      // 진행 상황 출력 (10개마다)
      if ((i + 1) % 10 === 0 || (i + 1) === existingReports.length) {
        console.log(`   [${i + 1}/${existingReports.length}] 처리 완료...`);
      }
    }
    
    // 4. 결과 확인
    console.log('\n' + '='.repeat(60));
    console.log('🎉 재정렬 완료!');
    console.log('='.repeat(60));
    
    const stats = await authQuery<any[]>(
      `SELECT 
        MIN(id) as min_id,
        MAX(id) as max_id,
        COUNT(*) as total_count,
        MIN(timestamp) as earliest_date,
        MAX(timestamp) as latest_date
       FROM lot_defect_reports`
    );
    
    console.log('\n📊 최종 통계:');
    console.table(stats);
    
    // 샘플 데이터 확인
    console.log('\n📋 샘플 데이터 (처음 5개):');
    const samples = await authQuery<any[]>(
      `SELECT id, lot_id, LEFT(report_content, 50) as preview, timestamp
       FROM lot_defect_reports
       ORDER BY id ASC
       LIMIT 5`
    );
    console.table(samples);
    
  } catch (error) {
    console.error('❌ 재정렬 오류:', error);
  }
}

reorderDefectReports();
