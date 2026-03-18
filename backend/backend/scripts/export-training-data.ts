#!/usr/bin/env tsx
/**
 * DB에서 학습용 데이터를 CSV로 내보내기
 * 
 * 사용법:
 *   npx tsx scripts/export-training-data.ts [출력 파일 경로]
 *   예: npx tsx scripts/export-training-data.ts data/training_export.csv
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// .env 로드 (다른 모듈 import 전에)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log('[Export] .env 파일 로드 완료');
} else {
  console.warn('[Export] ⚠️  .env 파일을 찾을 수 없습니다. 환경변수를 직접 설정하세요.');
}

const OUTPUT_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'minseo', 'backend', 'fastapi', 'data', 'training_export.csv');

// train_model.py가 기대하는 컬럼명
const REQUIRED_COLUMNS = [
  'lot_id',
  'timestamp',
  'd50',
  'metal_impurity',
  'lithium_input',
  'additive_ratio',
  'process_time',
  'sintering_temp',
  'humidity',
  'operator_id',
  'tank_pressure',
  'quality_defect'
];

// DB 컬럼명 → train_model.py 컬럼명 매핑 후보
const COLUMN_MAPPING: Record<string, string[]> = {
  lot_id: ['lot_id', 'lot', 'batch', 'batch_id', 'LOT'],
  timestamp: ['timestamp', 'date', 'created_at', 'recorded_at', 'dt', 'time'],
  d50: ['d50', 'D50', 'particle_size', 'mean_diameter'],
  metal_impurity: ['metal_impurity', 'impurity', 'contamination'],
  lithium_input: ['lithium_input', 'lithiuminput', 'lithium'],
  additive_ratio: ['additive_ratio', 'additiveratio', 'additive'],
  process_time: ['process_time', 'processtime', 'processing_time', 'duration'],
  sintering_temp: ['sintering_temp', 'sinteringtemp', 'sintering_temperature', 'temperature', 'temp'],
  humidity: ['humidity', 'moisture'],
  operator_id: ['operator_id', 'operator', 'op_id', 'worker_id'],
  tank_pressure: ['tank_pressure', 'tankpressure', 'pressure'],
  quality_defect: ['quality_defect', 'y_defect', 'defect', 'result', 'prediction', 'pass_fail']
};

function normalizeColumnName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_');
}

function findDbColumn(dbColumns: string[], targetCol: string): string | null {
  const candidates = COLUMN_MAPPING[targetCol] || [targetCol];
  const normalized = dbColumns.map(c => ({ orig: c, norm: normalizeColumnName(c) }));
  
  for (const candidate of candidates) {
    const normCand = normalizeColumnName(candidate);
    // 정확한 일치
    const exact = normalized.find(c => c.norm === normCand);
    if (exact) return exact.orig;
    
    // 부분 일치
    const partial = normalized.find(c => c.norm.includes(normCand) || normCand.includes(c.norm));
    if (partial) return partial.orig;
  }
  
  return null;
}

async function exportTrainingData() {
  // Dynamic import로 환경변수가 로드된 후에 모듈 가져오기
  const { getConnection, getProcessDataTable, getColumns, escapeSqlId } = await import('../src/lib/dashboard-db.js');
  
  const conn = await getConnection();
  
  try {
    console.log('[Export] 공정 테이블 확인 중...');
    const tableName = await getProcessDataTable(conn);
    console.log(`[Export] 테이블: ${tableName}`);
    
    const allColumns = await getColumns(conn, tableName);
    const dbColumnNames = allColumns.map(c => c.name);
    console.log(`[Export] DB 컬럼 수: ${dbColumnNames.length}`);
    
    // 매핑 테이블 구성
    const columnMap: Record<string, string | null> = {};
    const missingColumns: string[] = [];
    
    for (const targetCol of REQUIRED_COLUMNS) {
      const dbCol = findDbColumn(dbColumnNames, targetCol);
      columnMap[targetCol] = dbCol;
      if (!dbCol) {
        missingColumns.push(targetCol);
      }
    }
    
    console.log('[Export] 컬럼 매핑 결과:');
    for (const [target, db] of Object.entries(columnMap)) {
      if (db) {
        console.log(`  ${target} ← ${db}`);
      } else {
        console.log(`  ${target} ← (없음)`);
      }
    }
    
    if (missingColumns.length > 0) {
      console.warn(`\n[Export] ⚠️  필수 컬럼 누락: ${missingColumns.join(', ')}`);
      console.warn('[Export] 누락된 컬럼은 NULL 또는 기본값으로 채워집니다.');
    }
    
    // SELECT 쿼리 구성
    const selectParts: string[] = [];
    for (const targetCol of REQUIRED_COLUMNS) {
      const dbCol = columnMap[targetCol];
      if (dbCol) {
        selectParts.push(`${escapeSqlId(dbCol)} AS ${escapeSqlId(targetCol)}`);
      } else {
        // 누락된 컬럼은 NULL로 채우기
        selectParts.push(`NULL AS ${escapeSqlId(targetCol)}`);
      }
    }
    
    const query = `
      SELECT ${selectParts.join(', ')}
      FROM ${escapeSqlId(tableName)}
      ORDER BY ${columnMap.timestamp ? escapeSqlId(columnMap.timestamp) : '1'}
      LIMIT 50000
    `;
    
    console.log('[Export] 데이터 조회 중... (최대 50,000건)');
    const [rows]: any = await conn.query(query);
    console.log(`[Export] 조회된 행: ${rows.length}개`);
    
    if (rows.length === 0) {
      console.error('[Export] ❌ 조회된 데이터가 없습니다.');
      process.exit(1);
    }
    
    // CSV 작성
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const header = REQUIRED_COLUMNS.join(',') + '\n';
    const lines = rows.map((row: any) => {
      return REQUIRED_COLUMNS.map(col => {
        const val = row[col];
        if (val == null) return '';
        if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return String(val);
      }).join(',');
    }).join('\n');
    
    fs.writeFileSync(OUTPUT_PATH, header + lines, 'utf-8');
    console.log(`[Export] ✅ CSV 저장 완료: ${OUTPUT_PATH}`);
    console.log(`[Export] 행 수: ${rows.length}, 컬럼 수: ${REQUIRED_COLUMNS.length}`);
    
  } catch (error) {
    console.error('[Export] ❌ 에러 발생:', error);
    throw error;
  } finally {
    await conn.end();
  }
}

exportTrainingData().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
