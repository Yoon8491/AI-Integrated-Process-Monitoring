import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 6개 공정 변수만 사용
const BASE_FEATURES = [
  'lithium_input',
  'additive_ratio',
  'process_time',
  'humidity',
  'tank_pressure',
  'sintering_temp'
];

const FEATURE_NAMES_KR: Record<string, string> = {
  'lithium_input': '리튬 투입량',
  'additive_ratio': '첨가제 비율',
  'process_time': '공정 시간',
  'humidity': '습도',
  'tank_pressure': '탱크 압력',
  'sintering_temp': '소결 온도'
};

async function extractFeatureImportance() {
  try {
    console.log('🔍 Feature Importance 추출 시작...\n');
    
    // 1. 원본 Feature Importance 로드
    const inputPath = path.join(__dirname, '..', 'model', 'model_feature_importance.json');
    const rawData = fs.readFileSync(inputPath, 'utf-8');
    const featureImportance = JSON.parse(rawData);
    
    console.log(`📊 원본 Feature 개수: ${featureImportance.x_columns.length}개`);
    console.log(`📊 Source: ${featureImportance.source}\n`);
    
    // 2. 6개 공정 변수만 필터링
    const filteredFeatures: { feature: string; featureKr: string; importance: number }[] = [];
    
    featureImportance.x_columns.forEach((col: string, idx: number) => {
      if (BASE_FEATURES.includes(col)) {
        filteredFeatures.push({
          feature: col,
          featureKr: FEATURE_NAMES_KR[col],
          importance: featureImportance.base_feature_importance[idx]
        });
      }
    });
    
    // 3. 중요도 순으로 정렬
    filteredFeatures.sort((a, b) => b.importance - a.importance);
    
    // 4. 중요도 재정규화 (합이 1이 되도록)
    const totalImportance = filteredFeatures.reduce((sum, item) => sum + item.importance, 0);
    
    const normalizedFeatures = filteredFeatures.map(item => ({
      feature: item.feature,
      featureKr: item.featureKr,
      importance: item.importance / totalImportance,
      importancePercent: ((item.importance / totalImportance) * 100).toFixed(2)
    }));
    
    // 5. 결과 출력
    console.log('='.repeat(80));
    console.log('📊 6개 공정 변수 Feature Importance (정규화됨)');
    console.log('='.repeat(80));
    console.log('');
    
    normalizedFeatures.forEach((item, index) => {
      const bar = '█'.repeat(Math.round(parseFloat(item.importancePercent) / 2));
      console.log(`${(index + 1).toString().padStart(2)}. ${item.featureKr.padEnd(15)} | ${bar.padEnd(50)} | ${item.importancePercent.padStart(6)}%`);
    });
    
    console.log('');
    console.log('='.repeat(80));
    
    // 6. JSON 파일로 저장
    const outputData = {
      generatedAt: new Date().toISOString(),
      source: featureImportance.source + ' (filtered to 6 base features)',
      totalFeatures: normalizedFeatures.length,
      features: normalizedFeatures
    };
    
    const outputPath = path.join(__dirname, '..', 'analysis', 'feature_importance_6vars.json');
    const outputDir = path.dirname(outputPath);
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');
    
    console.log(`✅ 저장 완료: ${outputPath}`);
    console.log('');
    
    // 7. 차트 데이터도 생성 (프론트엔드용)
    const chartData = {
      labels: normalizedFeatures.map(item => item.featureKr),
      data: normalizedFeatures.map(item => parseFloat(item.importancePercent)),
      colors: normalizedFeatures.map((_, index) => {
        const colors = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e'];
        return colors[index] || '#64748b';
      })
    };
    
    const chartOutputPath = path.join(__dirname, '..', 'analysis', 'feature_importance_chart.json');
    fs.writeFileSync(chartOutputPath, JSON.stringify(chartData, null, 2), 'utf-8');
    
    console.log(`✅ 차트 데이터 저장: ${chartOutputPath}`);
    console.log('');
    
  } catch (error) {
    console.error('❌ 오류:', error);
  }
}

extractFeatureImportance();
