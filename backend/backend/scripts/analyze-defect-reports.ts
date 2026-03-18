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

const FEATURE_NAMES_KR: Record<string, string> = {
  'lithium_input': '리튬 투입량',
  'additive_ratio': '첨가제 비율',
  'process_time': '공정 시간',
  'humidity': '습도',
  'tank_pressure': '탱크 압력',
  'sintering_temp': '소결 온도',
  'metal_impurity': '금속 불순물',
  'd50': '입자 크기 (D50)'
};

interface DefectAnalysis {
  feature: string;
  featureKr: string;
  importance: number;
  avgValue: number;
  warningCount: number;
  dangerCount: number;
  totalCount: number;
}

async function analyzeDefectReports() {
  try {
    console.log('📊 불량 리포트 분석 시작...\n');
    
    // 1. 모든 리포트 데이터 가져오기
    console.log('🔍 리포트 데이터 조회 중...');
    const reports = await authQuery<any[]>(
      `SELECT lot_id, lot_data_json 
       FROM lot_defect_reports 
       ORDER BY timestamp ASC`
    );
    
    console.log(`✅ 총 ${reports.length}개의 리포트 분석\n`);
    
    if (reports.length === 0) {
      console.log('⚠️ 분석할 리포트가 없습니다.');
      return;
    }
    
    // 2. Feature별 통계 계산
    console.log('📈 Feature별 통계 계산 중...');
    
    const featureStats: Record<string, {
      values: number[];
      totalCount: number;
    }> = {};
    
    // 초기화
    Object.keys(FEATURE_NAMES_KR).forEach(feature => {
      featureStats[feature] = {
        values: [],
        totalCount: 0
      };
    });
    
    // 데이터 수집
    reports.forEach(report => {
      try {
        const lotData = JSON.parse(report.lot_data_json);
        Object.keys(FEATURE_NAMES_KR).forEach(feature => {
          const value = lotData[feature];
          if (value !== null && value !== undefined && !isNaN(value)) {
            featureStats[feature].values.push(value);
            featureStats[feature].totalCount++;
          }
        });
      } catch (error) {
        console.error(`JSON 파싱 오류 (${report.lot_id}):`, error);
      }
    });
    
    // 3. Feature Importance 계산 (표준편차 기반)
    const analysis: DefectAnalysis[] = [];
    
    Object.keys(FEATURE_NAMES_KR).forEach(feature => {
      const stats = featureStats[feature];
      
      if (stats.values.length === 0) {
        return;
      }
      
      // 평균 계산
      const avg = stats.values.reduce((a, b) => a + b, 0) / stats.values.length;
      
      // 표준편차 계산
      const variance = stats.values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / stats.values.length;
      const stdDev = Math.sqrt(variance);
      
      // 정규화된 중요도 (표준편차가 클수록 변동성이 크고 영향이 큼)
      const importance = stdDev;
      
      analysis.push({
        feature,
        featureKr: FEATURE_NAMES_KR[feature],
        importance,
        avgValue: avg,
        warningCount: 0,
        dangerCount: 0,
        totalCount: stats.totalCount
      });
    });
    
    // 중요도 순으로 정렬
    analysis.sort((a, b) => b.importance - a.importance);
    
    // 정규화 (0-100%)
    const maxImportance = analysis[0].importance;
    analysis.forEach(item => {
      item.importance = (item.importance / maxImportance) * 100;
    });
    
    // 4. 결과 출력
    console.log('\n' + '='.repeat(80));
    console.log('📊 불량에 영향을 미치는 주요 요인 분석 결과');
    console.log('='.repeat(80));
    
    console.log('\n🔥 Feature Importance (변동성 기반):');
    console.log('─'.repeat(80));
    
    analysis.forEach((item, index) => {
      const bar = '█'.repeat(Math.round(item.importance / 2)); // 최대 50칸
      const percentage = item.importance.toFixed(1);
      
      console.log(`${(index + 1).toString().padStart(2)}. ${item.featureKr.padEnd(20)} | ${bar.padEnd(50)} | ${percentage.padStart(5)}%`);
      console.log(`    평균값: ${item.avgValue.toFixed(4)} | 데이터 수: ${item.totalCount}`);
      console.log('');
    });
    
    // 5. JSON 파일로 저장
    const outputPath = path.join(__dirname, '..', 'analysis', 'defect_analysis.json');
    const outputDir = path.dirname(outputPath);
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const outputData = {
      generatedAt: new Date().toISOString(),
      totalReports: reports.length,
      featureImportance: analysis.map(item => ({
        feature: item.feature,
        featureKr: item.featureKr,
        importance: parseFloat(item.importance.toFixed(2)),
        avgValue: parseFloat(item.avgValue.toFixed(4)),
        totalCount: item.totalCount
      }))
    };
    
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');
    
    console.log('='.repeat(80));
    console.log(`✅ 분석 결과 저장 완료: ${outputPath}`);
    console.log('='.repeat(80));
    
    // 6. 상위 3개 요약
    console.log('\n🎯 주요 불량 원인 TOP 3:');
    analysis.slice(0, 3).forEach((item, index) => {
      console.log(`   ${index + 1}. ${item.featureKr} (중요도: ${item.importance.toFixed(1)}%)`);
    });
    console.log('');
    
  } catch (error) {
    console.error('❌ 분석 오류:', error);
  }
}

analyzeDefectReports();
