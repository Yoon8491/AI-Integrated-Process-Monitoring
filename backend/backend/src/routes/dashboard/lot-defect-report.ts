import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { requireAuth } from '../../middlewares/auth.js';
import { authQuery } from '../../db.js';
import { getConnection, getComparisonTable, getColumns, escapeSqlId } from '../../lib/dashboard-db.js';

/** 대시보드 파라미터 키(camelCase) → 학습 스크립트 feature 이름(snake_case) */
const PARAM_TO_MODEL_FEATURE: Record<string, string> = {
  lithiumInput: 'lithium_input',
  addictiveRatio: 'additive_ratio',
  processTime: 'process_time',
  humidity: 'humidity',
  tankPressure: 'tank_pressure',
  sinteringTemp: 'sintering_temp',
};

/**
 * 스태킹 모델(XGB+LGBM+RF) 학습 시 저장한 feature_importance JSON 로드.
 * train_model.py에서 model_feature_importance.json 으로 저장한 값을 사용해
 * "불량 원인별 영향도" 차트를 실제 학습된 중요도와 연동한다.
 */
export function loadModelFeatureImportance(): Record<string, number> | null {
  const envPath = process.env.MODEL_FEATURE_IMPORTANCE_JSON_PATH;
  const candidates: string[] = envPath ? [envPath] : [];
  try {
    const baseDir = process.cwd();
    candidates.push(
      path.join(baseDir, 'model', 'model_feature_importance.json'),
      path.join(baseDir, '..', 'minseo', 'backend', 'fastapi', 'model', 'model_feature_importance.json'),
      path.join(baseDir, '..', '..', 'minseo', 'backend', 'fastapi', 'model', 'model_feature_importance.json')
    );
  } catch {
    // ignore
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const data = JSON.parse(raw);
        const importance = data?.base_feature_importance ?? data;
        if (importance && typeof importance === 'object') {
          return importance as Record<string, number>;
        }
      }
    } catch {
      // try next path
    }
  }
  return null;
}

/**
 * Infinity, NaN 값을 안전한 값으로 변환하는 함수
 * JSON.stringify는 Infinity와 NaN을 지원하지 않으므로 null로 변환
 */
function sanitizeNumber(value: number): number | null {
  if (typeof value !== 'number') return value;
  if (!Number.isFinite(value)) {
    // Infinity, -Infinity, NaN을 null로 변환
    return null;
  }
  return value;
}

/**
 * 객체를 재귀적으로 순회하며 Infinity/NaN 값을 제거하는 함수
 */
function sanitizeForJSON(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'number') {
    return sanitizeNumber(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForJSON(item));
  }
  
  if (typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeForJSON(value);
    }
    return sanitized;
  }
  
  return obj;
}

async function ensureLotReportsTable() {
  await authQuery(`
    CREATE TABLE IF NOT EXISTS lot_defect_reports (
      id INT NOT NULL DEFAULT 0,
      lot_id VARCHAR(100) NOT NULL PRIMARY KEY,
      report_content TEXT NOT NULL,
      lot_data_json JSON,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_id (id),
      INDEX idx_timestamp (timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

/** id를 timestamp 시계열 순으로 재할당 (가장 오래된 데이터 = 1번) */
export async function renumberLotReportIds() {
  try {
    // MariaDB 10.2+ / MySQL 8.0+ ROW_NUMBER 사용
    await authQuery(`
      CREATE TEMPORARY TABLE _lot_report_renumber AS
      SELECT lot_id, ROW_NUMBER() OVER (ORDER BY timestamp ASC) as new_id
      FROM lot_defect_reports
    `);
    await authQuery(`
      UPDATE lot_defect_reports d
      INNER JOIN _lot_report_renumber r ON d.lot_id = r.lot_id
      SET d.id = r.new_id
    `);
    await authQuery(`DROP TEMPORARY TABLE _lot_report_renumber`);
  } catch (e) {
    console.warn('[renumberLotReportIds] 재할당 실패 (ROW_NUMBER 미지원 시):', (e as Error)?.message);
  }
}

async function getReportFromDb(lotId: string): Promise<{ report_content: string; lot_data_json: string | null } | null> {
  const rows = (await authQuery<{ report_content: string; lot_data_json: string | null }[]>(
    'SELECT report_content, lot_data_json FROM lot_defect_reports WHERE lot_id = ?',
    [lotId]
  )) as any as { report_content: string; lot_data_json: string | null }[];
  return rows?.length ? rows[0] : null;
}

async function saveReportToDb(
  lotId: string,
  reportContent: string,
  lotDataJson?: Record<string, unknown>
) {
  const jsonStr = lotDataJson ? JSON.stringify(lotDataJson) : null;
  await authQuery(
    `INSERT INTO lot_defect_reports (id, lot_id, report_content, lot_data_json, timestamp)
     VALUES (0, ?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE report_content = VALUES(report_content), lot_data_json = VALUES(lot_data_json), timestamp = CURRENT_TIMESTAMP`,
    [lotId, reportContent, jsonStr]
  );
  await renumberLotReportIds();
}

type VisualizationData = {
  charts?: Array<{
    type: 'bar' | 'line' | 'pie';
    title: string;
    data: Array<{ label: string; value: number; color?: string }>;
  }>;
  tables?: Array<{
    title: string;
    headers: string[];
    rows: string[][];
  }>;
  statistics?: {
    totalIssues: number;
    criticalIssues: number;
    parameterDeviations: Record<string, { value: number; normalRange: string; status: 'normal' | 'warning' | 'critical' }>;
  };
};

type ParameterStats = {
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  normalRange: { min: number; max: number };
};

type ParameterAnalysis = ParameterStats & {
  passMean: number;
  passStdDev: number;
  failMean: number;
  failStdDev: number;
  featureImportance: number; // LightGBM 방식: 합격/불량 분포 차이 기반 중요도
  tTestPValue?: number; // 통계적 유의성 (가능한 경우)
};

/** LOT별 불량 영향도 Top 1 파라미터 반환 (lot-status 테이블 음영용). 리포트와 동일한 영향도 계산 */
export function getTopImpactParamForLot(
  lotData: { lithiumInput?: number | null; addictiveRatio?: number | null; processTime?: number | null; humidity?: number | null; tankPressure?: number | null; sinteringTemp?: number | null },
  normalRanges: Record<string, ParameterAnalysis>,
  modelFeatureImportance: Record<string, number> | null
): string | null {
  const paramMap: Record<string, number | null> = {
    lithiumInput: lotData?.lithiumInput ?? null,
    addictiveRatio: lotData?.addictiveRatio ?? null,
    processTime: lotData?.processTime ?? null,
    humidity: lotData?.humidity ?? null,
    tankPressure: lotData?.tankPressure ?? null,
    sinteringTemp: lotData?.sinteringTemp ?? null,
  };
  let maxImpact = 0;
  let maxKey: string | null = null;
  for (const [key, value] of Object.entries(paramMap)) {
    if (value == null) continue;
    const analysis = normalRanges[key];
    if (!analysis) continue;
    const { normalRange, passMean, passStdDev, failMean, featureImportance } = analysis;
    const modelFeatKey = PARAM_TO_MODEL_FEATURE[key];
    const importanceForImpact = (modelFeatureImportance && modelFeatKey && modelFeatureImportance[modelFeatKey] != null)
      ? Number(modelFeatureImportance[modelFeatKey])
      : featureImportance;
    const zScore = passStdDev > 0.0001 ? Math.abs((value - passMean) / passStdDev) : 0;
    const safeZScore = Number.isFinite(zScore) ? zScore : 0;
    const safeFeatureImportance = Number.isFinite(importanceForImpact) ? importanceForImpact : 0;
    const weightedDeviation = Number.isFinite(safeZScore * (1 + safeFeatureImportance))
      ? safeZScore * (1 + safeFeatureImportance)
      : 0;
    const rangeDiff = Math.max(0.0001, normalRange.max - normalRange.min);
    const deviationFromNormal = value < normalRange.min
      ? Math.min(100, (normalRange.min - value) / rangeDiff)
      : value > normalRange.max
      ? Math.min(100, (value - normalRange.max) / rangeDiff)
      : 0;
    const safeWeightedDeviation = Number.isFinite(weightedDeviation) ? weightedDeviation : 0;
    const safeDeviationFromNormal = Number.isFinite(deviationFromNormal) ? deviationFromNormal : 0;
    const impactScore = Number.isFinite(safeWeightedDeviation * 0.3 + safeDeviationFromNormal * 0.7)
      ? Math.min(1.0, safeWeightedDeviation * 0.3 + safeDeviationFromNormal * 0.7)
      : 0;
    if (impactScore > maxImpact) {
      maxImpact = impactScore;
      maxKey = key;
    }
  }
  return maxKey;
}

/** data_sample 테이블 기반 정상 범위 계산 (MariaDB data_sample = 모델 학습 데이터와 동일) */
export async function calculateNormalRanges(
  paramNames: string[],
  _language: 'ko' | 'en'
): Promise<Record<string, ParameterAnalysis>> {
  const conn = await getConnection();
  try {
    // MariaDB data_sample 테이블 사용 (train_model.py 학습 데이터와 동일)
    const tableName = await getComparisonTable(conn);
    if (!tableName) {
      console.warn('[calculateNormalRanges] data_sample 테이블 없음 (COMPARISON_TABLE_NAME 환경변수 또는 project DB 확인)');
      return {};
    }

    // data_sample: quality_defect 0=합격, 1=불량 (train_model.py와 동일)
    const resultCol = 'quality_defect';
    const passCondition = `(CAST(${escapeSqlId(resultCol)} AS SIGNED) = 0 OR TRIM(CAST(${escapeSqlId(resultCol)} AS CHAR)) = '0')`;
    const failCondition = `(CAST(${escapeSqlId(resultCol)} AS SIGNED) = 1 OR TRIM(CAST(${escapeSqlId(resultCol)} AS CHAR)) = '1')`;

    const stats: Record<string, ParameterAnalysis> = {};

    // 파라미터 이름 매핑 (코드 이름 -> DB 컬럼명 후보)
    const paramMapping: Record<string, string[]> = {
      lithiumInput: ['lithium_input', 'lithiuminput', 'lithium input'],
      addictiveRatio: ['additive_ratio', 'additiveratio', 'additive ratio'],
      processTime: ['process_time', 'processtime', 'process time', 'processing_time'],
      humidity: ['humidity'],
      tankPressure: ['tank_pressure', 'tankpressure', 'tank pressure'],
      sinteringTemp: ['sintering_temp', 'sinteringtemp', 'sintering temp'],
    };

    for (const paramName of paramNames) {
      // 파라미터 컬럼 찾기
      const normParam = (s: string) => s.toLowerCase().replace(/\s+/g, '_');
      const allColumns = await getColumns(conn, tableName);
      const candidates = paramMapping[paramName] || [paramName];
      
      let paramCol: string | undefined;
      for (const candidate of candidates) {
        const found = allColumns.find(
          (c) => normParam(c.name) === normParam(candidate) ||
                 normParam(c.name).includes(normParam(candidate)) ||
                 normParam(candidate).includes(normParam(c.name))
        );
        if (found) {
          paramCol = found.name;
          break;
        }
      }

      if (!paramCol) continue;

      // 합격 LOT과 불량 LOT의 통계를 동시에 계산 (LightGBM 방식: 분포 비교)
      const query = `
        SELECT 
          -- 합격 LOT 통계
          AVG(CASE WHEN ${passCondition} THEN ${escapeSqlId(paramCol)} ELSE NULL END) as pass_mean,
          STDDEV(CASE WHEN ${passCondition} THEN ${escapeSqlId(paramCol)} ELSE NULL END) as pass_stddev,
          COUNT(CASE WHEN ${passCondition} THEN 1 END) as pass_count,
          -- 불량 LOT 통계
          AVG(CASE WHEN ${failCondition} THEN ${escapeSqlId(paramCol)} ELSE NULL END) as fail_mean,
          STDDEV(CASE WHEN ${failCondition} THEN ${escapeSqlId(paramCol)} ELSE NULL END) as fail_stddev,
          COUNT(CASE WHEN ${failCondition} THEN 1 END) as fail_count,
          -- 전체 통계
          MIN(${escapeSqlId(paramCol)}) as min_val,
          MAX(${escapeSqlId(paramCol)}) as max_val
        FROM ${escapeSqlId(tableName)}
        WHERE ${escapeSqlId(paramCol)} IS NOT NULL
          AND (${passCondition} OR ${failCondition})
      `;

      const [rows]: any = await conn.query(query);
      const row = rows?.[0];
      
      if (row && row.pass_count > 10 && row.pass_mean != null && row.pass_stddev != null) {
        const passMean = Number(row.pass_mean);
        const passStdDev = Number(row.pass_stddev) || 0;
        const failMean = row.fail_mean != null ? Number(row.fail_mean) : passMean;
        const failStdDev = row.fail_stddev != null ? Number(row.fail_stddev) || 0 : passStdDev;
        const passCount = Number(row.pass_count) || 0;
        const failCount = Number(row.fail_count) || 0;
        const min = Number(row.min_val);
        const max = Number(row.max_val);
        
        // Infinity/NaN 방지: 모든 값이 유한한지 확인
        const safePassMean = Number.isFinite(passMean) ? passMean : 0;
        const safePassStdDev = Number.isFinite(passStdDev) && passStdDev > 0 ? passStdDev : 0.0001;
        const safeFailMean = Number.isFinite(failMean) ? failMean : safePassMean;
        const safeFailStdDev = Number.isFinite(failStdDev) && failStdDev > 0 ? failStdDev : safePassStdDev;
        const safeMin = Number.isFinite(min) ? min : safePassMean - 1;
        const safeMax = Number.isFinite(max) ? max : safePassMean + 1;
        
        // LightGBM 방식: Feature Importance 계산
        // 합격 LOT과 불량 LOT의 평균 차이를 정규화하여 중요도 계산
        const meanDiff = Math.abs(safeFailMean - safePassMean);
        const pooledStdDev = Math.sqrt((safePassStdDev * safePassStdDev + safeFailStdDev * safeFailStdDev) / 2);
        // Infinity 방지: pooledStdDev가 0이거나 매우 작은 경우 처리
        const featureImportance = pooledStdDev > 0.0001 && Number.isFinite(meanDiff / (pooledStdDev * 2))
          ? Math.min(1.0, meanDiff / (pooledStdDev * 2)) // 정규화된 차이
          : 0;

        // 정상 범위: 합격 LOT의 평균 ± 2*표준편차 (95% 신뢰구간)
        // Infinity 방지: 계산 결과가 유한한지 확인
        const normalMinCalc = safePassMean - 2 * safePassStdDev;
        const normalMaxCalc = safePassMean + 2 * safePassStdDev;
        const normalMin = Number.isFinite(normalMinCalc) ? Math.max(safeMin, normalMinCalc) : safeMin;
        const normalMax = Number.isFinite(normalMaxCalc) ? Math.min(safeMax, normalMaxCalc) : safeMax;

        // 모든 값이 유한한지 확인하고 안전한 값으로 저장
        stats[paramName] = {
          mean: Number.isFinite(safePassMean) ? safePassMean : 0,
          stdDev: Number.isFinite(safePassStdDev) ? safePassStdDev : 0,
          min: Number.isFinite(safeMin) ? safeMin : 0,
          max: Number.isFinite(safeMax) ? safeMax : 0,
          normalRange: { 
            min: Number.isFinite(normalMin) ? normalMin : safeMin, 
            max: Number.isFinite(normalMax) ? normalMax : safeMax 
          },
          passMean: Number.isFinite(safePassMean) ? safePassMean : 0,
          passStdDev: Number.isFinite(safePassStdDev) ? safePassStdDev : 0,
          failMean: Number.isFinite(safeFailMean) ? safeFailMean : safePassMean,
          failStdDev: Number.isFinite(safeFailStdDev) ? safeFailStdDev : safePassStdDev,
          featureImportance: Number.isFinite(featureImportance) ? featureImportance : 0
        };
      }
    }

    return stats;
  } finally {
    conn.release();
  }
}

/** Z-score·편차를 비전공자 친화적 문구로 변환 */
function formatStatsForNonExpert(
  language: 'ko' | 'en',
  status: 'normal' | 'warning' | 'critical',
  value: number,
  passMean: number,
  _failMean: number,
  normalRange: { min: number; max: number },
  unit: string
): string {
  const fmt = (v: number, decimals = 2) => Number.isFinite(v) ? v.toFixed(decimals) : '-';
  const inRange = value >= normalRange.min && value <= normalRange.max;
  const aboveRange = value > normalRange.max;
  const belowRange = value < normalRange.min;

  if (language === 'ko') {
    if (status === 'normal') {
      if (inRange) {
        return `정상 범위 안에 있으며, 과거 합격 LOT 평균(약 ${fmt(passMean)}${unit})과 유사한 수준입니다.`;
      }
      return `정상 범위 내에 있습니다.`;
    }
    if (status === 'warning') {
      if (aboveRange) {
        const pct = normalRange.max > 0 ? (((value - normalRange.max) / normalRange.max) * 100).toFixed(0) : '0';
        return `정상 범위 상한(약 ${fmt(normalRange.max)}${unit})을 ${pct}% 초과했습니다. 합격 LOT 평균(약 ${fmt(passMean)}${unit})보다 높은 편입니다.`;
      }
      if (belowRange) {
        const pct = normalRange.min > 0 ? (((normalRange.min - value) / normalRange.min) * 100).toFixed(0) : '0';
        return `정상 범위 하한(약 ${fmt(normalRange.min)}${unit})을 ${pct}% 미만입니다. 합격 LOT 평균(약 ${fmt(passMean)}${unit})보다 낮은 편입니다.`;
      }
      return `정상 범위를 다소 벗어났습니다. 합격 LOT 평균(약 ${fmt(passMean)}${unit})과 차이가 있습니다.`;
    }
    // critical
    if (aboveRange) {
      return `정상 범위를 크게 초과했습니다. 즉시 점검 및 조정이 필요합니다. (합격 LOT 평균: 약 ${fmt(passMean)}${unit})`;
    }
    if (belowRange) {
      return `정상 범위를 크게 미달했습니다. 즉시 점검 및 조정이 필요합니다. (합격 LOT 평균: 약 ${fmt(passMean)}${unit})`;
    }
    return `심각한 편차가 확인되었습니다. 즉시 점검이 필요합니다.`;
  }

  // English
  if (status === 'normal') {
    return `Within normal range, similar to pass LOT average (approx. ${fmt(passMean)}${unit}).`;
  }
  if (status === 'warning') {
    if (aboveRange) {
      return `Exceeds normal upper limit (approx. ${fmt(normalRange.max)}${unit}). Higher than pass LOT average (approx. ${fmt(passMean)}${unit}).`;
    }
    if (belowRange) {
      return `Below normal lower limit (approx. ${fmt(normalRange.min)}${unit}). Lower than pass LOT average (approx. ${fmt(passMean)}${unit}).`;
    }
    return `Slightly outside normal range. Differs from pass LOT average (approx. ${fmt(passMean)}${unit}).`;
  }
  if (aboveRange || belowRange) {
    return `Significantly outside normal range. Immediate inspection required. (Pass LOT avg: approx. ${fmt(passMean)}${unit})`;
  }
  return `Significant deviation detected. Immediate inspection required.`;
}

/** 불량 LOT의 파라미터 편차 분석 및 시각화 데이터 생성. modelFeatureImportance 있으면 스태킹 모델(XGB+LGBM+RF) 중요도로 영향도 연동 */
function analyzeDefectCauses(
  lotData: any,
  normalRanges: Record<string, ParameterAnalysis>,
  language: 'ko' | 'en',
  modelFeatureImportance: Record<string, number> | null = null
): VisualizationData {
  const charts: VisualizationData['charts'] = [];
  const tables: VisualizationData['tables'] = [];
  const parameterDeviations: Record<string, { value: number; normalRange: string; status: 'normal' | 'warning' | 'critical' }> = {};
  
  const paramMap: Record<string, { value: number | null; name: { ko: string; en: string } }> = {
    lithiumInput: { value: lotData?.lithiumInput ?? null, name: { ko: '리튬 투입량', en: 'Lithium Input' } },
    addictiveRatio: { value: lotData?.addictiveRatio ?? null, name: { ko: '첨가제 비율', en: 'Additive Ratio' } },
    processTime: { value: lotData?.processTime ?? null, name: { ko: '공정 시간', en: 'Process Time' } },
    humidity: { value: lotData?.humidity ?? null, name: { ko: '습도', en: 'Humidity' } },
    tankPressure: { value: lotData?.tankPressure ?? null, name: { ko: '탱크 압력', en: 'Tank Pressure' } },
    sinteringTemp: { value: lotData?.sinteringTemp ?? null, name: { ko: '소결 온도', en: 'Sintering Temp' } },
  };

  const chartData: Array<{ label: string; value: number; color: string }> = [];
  const tableRows: string[][] = [];
  const impactByKey: Record<string, number> = {};
  let totalIssues = 0;
  let criticalIssues = 0;

  // LightGBM 방식: Feature Importance를 고려한 영향도 계산
  // normalRanges가 없어도 최소한의 테이블은 생성
  const hasNormalRanges = Object.keys(normalRanges).length > 0;
  
  for (const [key, param] of Object.entries(paramMap)) {
    const paramName = language === 'ko' ? param.name.ko : param.name.en;
    if (param.value == null) {
      // 데이터 없어도 6개 파라미터 모두 차트에 포함 (0%로)
      impactByKey[key] = 0;
      chartData.push({ label: paramName, value: 0, color: '#3b82f6' });
      tableRows.push([
        paramName,
        '-',
        language === 'ko' ? '데이터 없음' : 'No data',
        language === 'ko' ? '확인 필요' : 'Needs verification',
        language === 'ko' ? '측정값 없음' : 'No measurement'
      ]);
      continue;
    }

    const analysis = normalRanges[key];
    
    // normalRanges가 없으면 기본값으로 표시
    if (!analysis) {
      // normalRanges가 없어도 항상 테이블 행 생성
      const unit = key === 'lithiumInput' ? ' kg' : 
                   key === 'addictiveRatio' ? '' :
                   key === 'processTime' ? ' 분' :
                   key === 'humidity' ? '%' :
                   key === 'tankPressure' ? ' kPa' :
                   key === 'sinteringTemp' ? ' °C' : '';
      const valueStr = `${param.value.toFixed(4)}${unit}`;
      tableRows.push([
        paramName,
        valueStr,
        language === 'ko' ? '데이터 부족' : 'Insufficient data',
        language === 'ko' ? '확인 필요' : 'Needs verification',
        language === 'ko' ? '정상 범위 데이터 없음' : 'No normal range data'
      ]);
      // 차트 데이터에도 추가 (기본 영향도 0.5)
      impactByKey[key] = 0.5;
      chartData.push({
        label: paramName,
        value: 0.5,
        color: '#f59e0b'
      });
      continue;
    }

    const value = param.value;
    const { normalRange, passMean, passStdDev, failMean, featureImportance } = analysis;
    // 스태킹 모델에서 저장한 중요도가 있으면 우선 사용 (train_model.py → model_feature_importance.json)
    const modelFeatKey = PARAM_TO_MODEL_FEATURE[key];
    const importanceForImpact = (modelFeatureImportance && modelFeatKey && modelFeatureImportance[modelFeatKey] != null)
      ? Number(modelFeatureImportance[modelFeatKey])
      : featureImportance;

    // Z-score 기반 편차 계산 (합격 LOT 분포 기준)
    // Infinity 방지: passStdDev가 0이거나 매우 작은 경우 처리
    const zScore = passStdDev > 0.0001 
      ? Math.abs((value - passMean) / passStdDev) 
      : 0;
    
    // 불량 LOT 평균과의 거리도 고려
    const distanceToFailMean = passStdDev > 0.0001
      ? Math.abs((value - failMean) / passStdDev) 
      : 0;
    
    // Feature Importance 가중치 적용 (스태킹 모델 중요도 우선)
    // Infinity 방지: 값이 유한한지 확인
    const safeZScore = Number.isFinite(zScore) ? zScore : 0;
    const safeFeatureImportance = Number.isFinite(importanceForImpact) ? importanceForImpact : 0;
    const weightedDeviation = Number.isFinite(safeZScore * (1 + safeFeatureImportance))
      ? safeZScore * (1 + safeFeatureImportance)
      : 0;
    
    // deviationFromNormal 계산 시 Infinity 방지
    const rangeDiff = Math.max(0.0001, normalRange.max - normalRange.min);
    const deviationFromNormal = value < normalRange.min 
      ? Math.min(100, (normalRange.min - value) / rangeDiff) // 최대값 제한
      : value > normalRange.max
      ? Math.min(100, (value - normalRange.max) / rangeDiff) // 최대값 제한
      : 0;

    // LightGBM 방식: 통계적 유의성 고려한 상태 결정
    // Z-score > 2: 경고, Z-score > 3: 심각
    let status: 'normal' | 'warning' | 'critical' = 'normal';
    if (zScore > 3 || deviationFromNormal > 0.5) {
      status = 'critical';
      criticalIssues++;
      totalIssues++;
    } else if (zScore > 2 || deviationFromNormal > 0.2) {
      status = 'warning';
      totalIssues++;
    }

    // LightGBM 방식: Feature Importance와 편차를 결합한 영향도 점수
    // 영향도 = (편차 정도 * Feature Importance 가중치)
    // Infinity 방지: 모든 값이 유한한지 확인
    const safeWeightedDeviation = Number.isFinite(weightedDeviation) ? weightedDeviation : 0;
    const safeDeviationFromNormal = Number.isFinite(deviationFromNormal) ? deviationFromNormal : 0;
    const impactScore = Number.isFinite(safeWeightedDeviation * 0.3 + safeDeviationFromNormal * 0.7)
      ? Math.min(1.0, safeWeightedDeviation * 0.3 + safeDeviationFromNormal * 0.7)
      : 0;

    const unit = key === 'lithiumInput' ? ' kg' : 
                 key === 'addictiveRatio' ? '' :
                 key === 'processTime' ? ' 분' :
                 key === 'humidity' ? '%' :
                 key === 'tankPressure' ? ' kPa' :
                 key === 'sinteringTemp' ? ' °C' : '';

    const normalRangeStr = `${normalRange.min.toFixed(4)}${unit} - ${normalRange.max.toFixed(4)}${unit}`;
    const valueStr = `${value.toFixed(4)}${unit}`;
    const statusStr = language === 'ko' 
      ? (status === 'normal' ? '정상' : status === 'warning' ? '경고' : '심각')
      : (status === 'normal' ? 'Normal' : status === 'warning' ? 'Warning' : 'Critical');

    // 통계 정보 (비전공자 친화적 설명)
    const comparisonInfo = formatStatsForNonExpert(
      language,
      status,
      value,
      passMean,
      failMean,
      normalRange,
      unit
    );

    // value가 Infinity나 NaN인지 확인하고 안전한 값으로 변환
    const safeValue = Number.isFinite(value) ? value : null;
    parameterDeviations[key] = {
      value: safeValue,
      normalRange: normalRangeStr,
      status
    };

    // 6개 파라미터 모두 차트에 포함 (필터 제거)
    impactByKey[key] = impactScore;
    chartData.push({
      label: paramName,
      value: impactScore,
      color: status === 'critical' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#3b82f6'
    });

    tableRows.push([
      paramName,
      valueStr,
      normalRangeStr,
      statusStr,
      comparisonInfo
    ]);
  }

  // 백분율로 정규화 (합계 100%). 최고 영향도 = 빨간색 (동점이면 모두 빨간색)
  const useStackingModel = modelFeatureImportance != null && Object.keys(modelFeatureImportance).length > 0;
  const chartTitle = language === 'ko'
    ? (useStackingModel ? '파라미터별 불량 영향도 (%) - LGBM+XGBoost+RF 스태킹 모델 기반' : '파라미터별 불량 영향도 (%) - LightGBM 분석')
    : (useStackingModel ? 'Parameter Defect Impact (%) - LGBM+XGBoost+RF Stacking' : 'Parameter Defect Impact (%) - LightGBM Analysis');
  if (chartData.length > 0) {
    const sorted = chartData.sort((a, b) => b.value - a.value);
    const total = sorted.reduce((s, d) => s + (d.value || 0), 0);
    const normalized = total > 0
      ? (() => {
          const withPct = sorted.map((d) => {
            const pct = ((d.value || 0) / total) * 100;
            return { ...d, value: Number(pct.toFixed(1)), _pct: pct };
          });
          const maxPct = Math.max(...withPct.map((x) => x._pct));
          return withPct.map(({ _pct, ...rest }) => ({
            ...rest,
            color: _pct === maxPct && _pct > 0 ? '#ef4444' : (_pct > 0 ? '#f59e0b' : '#3b82f6')
          }));
        })()
      : (() => {
          const val = Number((100 / sorted.length).toFixed(1));
          return sorted.map((d) => ({ ...d, value: val, color: '#ef4444' }));
        })();
    charts.push({
      type: 'bar',
      title: chartTitle,
      data: normalized
    });
  } else {
    charts.push({
      type: 'bar',
      title: chartTitle,
      data: [{
        label: language === 'ko' ? '분석 데이터 없음' : 'No analysis data',
        value: 0,
        color: '#6b7280'
      }]
    });
  }

  const tableSubtitle = useStackingModel
    ? (language === 'ko' ? '공정 파라미터 이상 여부 (스태킹 모델 기반)' : 'Process Parameter Status (Stacking model)')
    : (language === 'ko' ? '공정 파라미터 이상 여부 (LightGBM 분석)' : 'Process Parameter Status (LightGBM Analysis)');
  if (tableRows.length > 0) {
    tables.push({
      title: tableSubtitle,
      headers: language === 'ko' 
        ? ['파라미터', '측정값', '정상 범위', '상태', '통계 정보']
        : ['Parameter', 'Value', 'Normal Range', 'Status', 'Statistics'],
      rows: tableRows
    });
  } else {
    tables.push({
      title: tableSubtitle,
      headers: language === 'ko' 
        ? ['파라미터', '측정값', '정상 범위', '상태', '통계 정보']
        : ['Parameter', 'Value', 'Normal Range', 'Status', 'Statistics'],
      rows: [[
        language === 'ko' ? '파라미터 데이터 없음' : 'No parameter data',
        '-',
        '-',
        language === 'ko' ? '확인 필요' : 'Needs verification',
        language === 'ko' ? '데이터 부족' : 'Insufficient data'
      ]]
    });
  }

  // LOT별 불량 영향도 Top 1 파라미터 (lot-status 테이블 음영용)
  const topImpactParam = Object.keys(impactByKey).length > 0
    ? (Object.entries(impactByKey).reduce((a, b) => (a[1] >= b[1] ? a : b))[0] as keyof typeof paramMap)
    : null;

  const result = {
    charts,
    tables,
    topImpactParam,
    statistics: {
      totalIssues,
      criticalIssues,
      parameterDeviations
    }
  };
  
  return result;
}

export async function generateDefectReport(
  lotId: string,
  lotData: any,
  language: 'ko' | 'en' = 'ko'
): Promise<{ textReport: string; visualization: VisualizationData }> {
  // LightGBM 방식: 데이터 기반 분석 먼저 수행
  const paramNames = ['lithiumInput', 'addictiveRatio', 'processTime', 'humidity', 'tankPressure', 'sinteringTemp'];
  let normalRanges: Record<string, ParameterAnalysis>;
  try {
    normalRanges = await calculateNormalRanges(paramNames, language);
  } catch (error) {
    console.error('[generateDefectReport] Failed to calculate normal ranges:', error);
    normalRanges = {};
  }
  
  const modelFeatureImportance = loadModelFeatureImportance();
  const visualization = analyzeDefectCauses(lotData, normalRanges, language, modelFeatureImportance);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  // 불량 원인 기여도 (%) - charts의 value를 정규화
  const chartData = visualization.charts?.[0]?.data ?? [];
  const totalImpact = chartData.reduce((s, d) => s + (d.value || 0), 0) || 1;
  const impactPercentages = chartData.map((d) => ({
    label: d.label,
    pct: ((d.value || 0) / totalImpact * 100).toFixed(1)
  }));

  const params = lotData?.params || {};
  const paramsStr =
    Object.keys(params).length > 0
      ? Object.entries(params)
          .map(([k, v]) => {
            const numValue = Number(v as any);
            const safeValue = Number.isFinite(numValue) ? numValue : 0;
            return `  ${k}: ${safeValue.toFixed(4)}`;
          })
          .join('\n')
      : '';

  // Infinity/NaN 방지: 안전한 값으로 변환
  const safeNumber = (value: any, decimals: number = 4): string => {
    if (value == null) return '-';
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    return decimals === 2 ? num.toFixed(2) : num.toFixed(4);
  };
  
  const lotDataText =
    language === 'ko'
      ? `--- LOT 데이터 ---
LOT ID: ${lotId}
판정: ${lotData?.passFailResult ?? '-'}
리튬 투입량: ${lotData?.lithiumInput != null ? `${safeNumber(lotData.lithiumInput)} kg` : '-'}
첨가제 비율: ${lotData?.addictiveRatio != null ? safeNumber(lotData.addictiveRatio) : '-'}
공정 시간: ${lotData?.processTime != null ? `${safeNumber(lotData.processTime, 2)} 분` : '-'}
습도: ${lotData?.humidity != null ? `${safeNumber(lotData.humidity, 2)}%` : '-'}
탱크 압력: ${lotData?.tankPressure != null ? `${safeNumber(lotData.tankPressure, 2)} kPa` : '-'}
소결 온도: ${lotData?.sinteringTemp != null ? `${safeNumber(lotData.sinteringTemp, 2)} °C` : '-'}
기록 수: ${lotData?.recordCount ?? 0}
최근 기록: ${lotData?.latestDate ?? '-'}
${paramsStr ? `기타 파라미터:\n${paramsStr}` : ''}`
      : `--- LOT Data ---
LOT ID: ${lotId}
Result: ${lotData?.passFailResult ?? '-'}
Lithium input: ${lotData?.lithiumInput != null ? `${safeNumber(lotData.lithiumInput)} kg` : '-'}
Additive ratio: ${lotData?.addictiveRatio != null ? safeNumber(lotData.addictiveRatio) : '-'}
Process time: ${lotData?.processTime != null ? `${safeNumber(lotData.processTime, 2)} min` : '-'}
Humidity: ${lotData?.humidity != null ? `${safeNumber(lotData.humidity, 2)}%` : '-'}
Tank pressure: ${lotData?.tankPressure != null ? `${safeNumber(lotData.tankPressure, 2)} kPa` : '-'}
Sintering temp: ${lotData?.sinteringTemp != null ? `${safeNumber(lotData.sinteringTemp, 2)} °C` : '-'}
Record count: ${lotData?.recordCount ?? 0}
Latest: ${lotData?.latestDate ?? '-'}
${paramsStr ? `Other params:\n${paramsStr}` : ''}`;

  // LightGBM 분석 결과 요약 (비전공자 친화적 문구)
  const analysisSummaryParts = Object.entries(normalRanges)
    .map(([key, analysis]) => {
      const param = paramNames.includes(key) ? key : null;
      if (!param) return '';
      const value = lotData?.[param] ?? null;
      if (value == null || !Number.isFinite(value)) return '';
      
      const safeValue = Number.isFinite(value) ? value : 0;
      const safePassMean = Number.isFinite(analysis.passMean) ? analysis.passMean : 0;
      const safePassStdDev = Number.isFinite(analysis.passStdDev) && analysis.passStdDev > 0.0001 ? analysis.passStdDev : 0.0001;
      const safeNormalMin = Number.isFinite(analysis.normalRange.min) ? analysis.normalRange.min : safePassMean - 1;
      const safeNormalMax = Number.isFinite(analysis.normalRange.max) ? analysis.normalRange.max : safePassMean + 1;
      
      const zScore = safePassStdDev > 0.0001 ? Math.abs((safeValue - safePassMean) / safePassStdDev) : 0;
      const rangeDiff = Math.max(0.0001, safeNormalMax - safeNormalMin);
      const deviation = safeValue < safeNormalMin 
        ? Math.min(100, (safeNormalMin - safeValue) / rangeDiff)
        : safeValue > safeNormalMax
        ? Math.min(100, (safeValue - safeNormalMax) / rangeDiff)
        : 0;
      
      const safeZScore = Number.isFinite(zScore) ? zScore : 0;
      const safeDeviation = Number.isFinite(deviation) ? deviation : 0;
      const status = safeZScore > 3 || safeDeviation > 0.5 ? 'critical' : safeZScore > 2 || safeDeviation > 0.2 ? 'warning' : 'normal';
      
      const unit = key === 'lithiumInput' ? ' kg' : key === 'addictiveRatio' ? '' : key === 'processTime' ? ' 분' : key === 'humidity' ? '%' : key === 'tankPressure' ? ' kPa' : ' °C';
      const paramName = language === 'ko' 
        ? (key === 'lithiumInput' ? '리튬 투입량' : key === 'addictiveRatio' ? '첨가제 비율' : key === 'processTime' ? '공정 시간' : key === 'humidity' ? '습도' : key === 'tankPressure' ? '탱크 압력' : '소결 온도')
        : (key === 'lithiumInput' ? 'Lithium Input' : key === 'addictiveRatio' ? 'Additive Ratio' : key === 'processTime' ? 'Process Time' : key === 'humidity' ? 'Humidity' : key === 'tankPressure' ? 'Tank Pressure' : 'Sintering Temp');
      
      const desc = formatStatsForNonExpert(language, status, safeValue, safePassMean, analysis.failMean, { min: safeNormalMin, max: safeNormalMax }, unit);
      return `${paramName}: 측정값 ${safeValue.toFixed(4)}${unit}, 정상범위 ${safeNormalMin.toFixed(4)}~${safeNormalMax.toFixed(4)}${unit}. ${desc}`;
    })
    .filter(Boolean);

  const impactSummary = impactPercentages.length > 0
    ? (language === 'ko'
        ? `불량 원인 기여도: ${impactPercentages.map((p) => `${p.label} (${p.pct}%)`).join(', ')}`
        : `Defect cause contribution: ${impactPercentages.map((p) => `${p.label} (${p.pct}%)`).join(', ')}`)
    : '';

  const analysisSummary = [impactSummary, ...analysisSummaryParts].filter(Boolean).join('\n\n');

  const systemPrompt =
    language === 'ko'
      ? '당신은 배터리 전극 제조 공정 분석 전문가입니다. 비전공자도 이해할 수 있도록 불량 LOT 분석 레포트를 작성해주세요. 레포트 제목이나 LOT ID를 본문에 다시 언급하지 마세요. 권장 조치사항은 반드시 번호(1. 2. 3.)를 사용하여 나열해주세요.'
      : 'You are a battery electrode manufacturing process analyst. Write defect LOT reports that non-engineers can understand. Do not mention the report title or LOT ID again in the body. Use numbered list (1. 2. 3.) for Recommended Actions.';

  const userPrompt =
    language === 'ko'
      ? `다음 불량 LOT에 대한 불량 원인 분석 레포트를 작성해주세요. 반드시 아래 양식을 따르세요:

**불량 원인 분석**: 6개 파라미터(리튬 투입량, 첨가제 비율, 공정 시간, 습도, 탱크 압력, 소결 온도) 모두를 "{파라미터} (X.X%)" 형식으로 나열하세요. 합계는 100%가 되어야 합니다.

**불량 발생 메커니즘**:
각 파라미터별로 비전공자도 이해할 수 있게, 해당 파라미터가 정상 범위를 벗어났을 때 배터리 전극·전지에 어떤 영향을 미치는지 구체적으로 설명하세요. 예: 리튬 투입량 초과 시 전극 리튬 저항 증가 → 구조적 안정성 저하 → 성능 악화 등.

**권장 조치사항**:
1. 첫 번째 권장 조치 (가장 중요)
2. 두 번째 권장 조치
3. 세 번째 권장 조치

중요: LOT ID나 제목을 본문에 다시 언급하지 마세요. 권장 조치사항에는 반드시 번호를 사용하세요.

--- LOT 데이터 ---
${lotDataText}

--- 분석 결과 ---
${analysisSummary}`
      : `Write a Defect Cause Analysis Report for the following failed LOT. Follow this format:

**Defect Cause Analysis**: List all 6 parameters (Lithium Input, Additive Ratio, Process Time, Humidity, Tank Pressure, Sintering Temp) as "{param} (X.X%)". Total must sum to 100%.

**Defect Mechanism**:
Explain in plain language how each parameter deviation affects battery electrode/cell when it goes out of normal range.

**Recommended Actions**:
1. First action (most important)
2. Second action
3. Third action

Do not mention LOT ID or title in the body. Use numbers for Recommended Actions.

--- LOT Data ---
${lotDataText}

--- Analysis Results ---
${analysisSummary}`;

  const visualizationPrompt =
    language === 'ko'
      ? `위 LOT 데이터를 분석하여 시각화 데이터를 JSON 형식으로 생성해주세요. 다음 형식을 정확히 따르세요:

{
  "charts": [
    {
      "type": "bar",
      "title": "불량 원인별 영향도",
      "data": [
        { "label": "리튬 투입량 이상", "value": 0.8, "color": "#ef4444" },
        { "label": "첨가제 비율 이상", "value": 0.6, "color": "#f59e0b" },
        { "label": "공정 시간 이상", "value": 0.4, "color": "#3b82f6" }
      ]
    }
  ],
  "tables": [
    {
      "title": "공정 파라미터 이상 여부",
      "headers": ["파라미터", "측정값", "정상 범위", "상태"],
      "rows": [
        ["리튬 투입량", "2.3456 kg", "2.0-2.5 kg", "정상"],
        ["첨가제 비율", "0.1234", "0.1-0.15", "정상"]
      ]
    }
  ],
  "statistics": {
    "totalIssues": 2,
    "criticalIssues": 1,
    "parameterDeviations": {
      "lithiumInput": { "value": 2.3456, "normalRange": "2.0-2.5", "status": "normal" },
      "addictiveRatio": { "value": 0.1234, "normalRange": "0.1-0.15", "status": "normal" }
    }
  }
}

중요:
- JSON만 반환하세요 (다른 텍스트 없이)
- 파라미터 값이 정상 범위를 벗어나면 status를 "warning" 또는 "critical"로 설정
- charts의 value는 0.0-1.0 사이의 영향도 점수
- 정상 범위는 일반적인 제조 공정 기준으로 추정`
      : `Analyze the LOT data above and generate visualization data in JSON format. Follow this exact format:

{
  "charts": [
    {
      "type": "bar",
      "title": "Defect Cause Impact",
      "data": [
        { "label": "Lithium Input Deviation", "value": 0.8, "color": "#ef4444" },
        { "label": "Additive Ratio Deviation", "value": 0.6, "color": "#f59e0b" }
      ]
    }
  ],
  "tables": [
    {
      "title": "Process Parameter Status",
      "headers": ["Parameter", "Value", "Normal Range", "Status"],
      "rows": [
        ["Lithium Input", "2.3456 kg", "2.0-2.5 kg", "Normal"],
        ["Additive Ratio", "0.1234", "0.1-0.15", "Normal"]
      ]
    }
  ],
  "statistics": {
    "totalIssues": 2,
    "criticalIssues": 1,
    "parameterDeviations": {
      "lithiumInput": { "value": 2.3456, "normalRange": "2.0-2.5", "status": "normal" }
    }
  }
}

Important:
- Return JSON only (no other text)
- Set status to "warning" or "critical" if parameter values deviate from normal range
- charts value should be impact score between 0.0-1.0
- Estimate normal ranges based on typical manufacturing process standards`;

  // 시각화 데이터는 이미 LightGBM 방식으로 계산됨
  // OpenAI API 호출 시도 (실패해도 시각화 데이터는 반환)
  let textReport = '';
  
  
  try {
    const openai = new OpenAI({ apiKey });
    const modelName = process.env.OPENAI_MODEL_NAME || 'gpt-4o-mini';

    // 텍스트 레포트 생성
    const textCompletion = await openai.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
    });

    textReport = textCompletion.choices[0]?.message?.content || '';
  } catch (openaiError: any) {
    console.error('[generateDefectReport] ❌ OpenAI API error:', openaiError?.message || openaiError);
    // OpenAI API 실패 시 기본 텍스트 레포트 생성
    const paramSummary = Object.entries(paramMap)
      .filter(([_, param]) => param.value != null)
      .map(([key, param]) => {
        const paramName = language === 'ko' ? param.name.ko : param.name.en;
        const unit = key === 'lithiumInput' ? ' kg' : 
                     key === 'addictiveRatio' ? '' :
                     key === 'processTime' ? ' 분' :
                     key === 'humidity' ? '%' :
                     key === 'tankPressure' ? ' kPa' :
                     key === 'sinteringTemp' ? ' °C' : '';
        return `${paramName}: ${param.value?.toFixed(4)}${unit}`;
      })
      .join(', ');
    
    const fallbackImpact = impactPercentages.length > 0
      ? impactPercentages.map((p) => `${p.label} (${p.pct}%)`).join(', ')
      : paramSummary;
    textReport = language === 'ko'
      ? `**불량 원인 분석**: "${fallbackImpact}"\n\n**불량 발생 메커니즘**:\n공정 파라미터 분석 결과, ${paramSummary} 등의 값이 측정되었습니다. 상세 메커니즘은 아래 시각화 데이터를 참고하세요.\n\n**권장 조치사항**:\n1. 정상 범위를 벗어난 파라미터를 최적 범위로 조정합니다.\n2. 투입·공정 과정의 실시간 모니터링을 강화하여 불량 재발을 방지합니다.\n3. 재검사 후 유효성을 확인합니다.`
      : `**Defect Cause Analysis**: "${fallbackImpact}"\n\n**Defect Mechanism**:\nProcess parameter analysis shows: ${paramSummary}. See visualization below for details.\n\n**Recommended Actions**:\n1. Adjust out-of-range parameters to optimal ranges.\n2. Strengthen real-time monitoring to prevent recurrence.\n3. Verify effectiveness through re-inspection.`;
  }

  // 시각화 데이터는 항상 반환 (OpenAI API 실패와 무관)
  return { textReport, visualization };
}

export async function registerDashboardLotDefectReport(app: FastifyInstance) {
  app.get('/api/dashboard/lot-defect-report', async (request, reply) => {
    // 디버깅: 인증 헤더 확인
    const authHeader = request.headers.authorization;
    request.log.info({ 
      hasAuthHeader: !!authHeader,
      authHeaderPreview: authHeader ? `${authHeader.substring(0, 30)}...` : null,
      allHeaders: Object.keys(request.headers)
    }, 'Lot defect report GET request');
    
    const user = await requireAuth(request as any);
    if (!user) {
      request.log.warn({ authHeader }, 'Unauthorized: requireAuth returned null');
      return reply.code(401).send({ success: false, error: 'Unauthorized' });
    }

    const q = (request.query || {}) as any;
    const lotId = q.lotId ? String(q.lotId) : '';
    if (!lotId) return reply.code(400).send({ success: false, error: 'lotId is required' });

    await ensureLotReportsTable();
    const reportData = await getReportFromDb(lotId);
    if (!reportData) return reply.code(404).send({ success: false, error: 'NOT_FOUND' });
    
    let visualization: VisualizationData | null = null;
    try {
      if (reportData.lot_data_json) {
        const parsed = JSON.parse(reportData.lot_data_json);
        if (parsed.visualization) {
          visualization = parsed.visualization;
        }
      }
    } catch (e) {
      console.error('Failed to parse visualization data:', e);
    }
    
    // Infinity/NaN 값 제거 후 반환
    const sanitizedVisualization = visualization ? sanitizeForJSON(visualization) : null;
    
    return reply.send({ 
      success: true, 
      lotId, 
      report: reportData.report_content,
      visualization: sanitizedVisualization
    });
  });

  app.post('/api/dashboard/lot-defect-report', async (request, reply) => {
    const user = await requireAuth(request as any);
    if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized' });

    // ⛔ API로 레포트 생성 중지. 스크립트(rebuild-defect-reports-from-scratch.ts)로만 생성
    const REPORTS_API_DISABLED = true;
    if (REPORTS_API_DISABLED) {
      return reply.code(403).send({
        success: false,
        error: '레포트 생성이 중지되어 있습니다. rebuild-defect-reports-from-scratch.ts 스크립트로만 생성 가능합니다.'
      });
    }

    const body = request.body as any;
    const lotId = body?.lotId ? String(body.lotId) : '';
    const lotData = body?.lotData;
    const language = (body?.language === 'en' ? 'en' : 'ko') as 'ko' | 'en';
    if (!lotId || !lotData) return reply.code(400).send({ success: false, error: 'lotId and lotData are required' });

    await ensureLotReportsTable();
    const existing = await getReportFromDb(lotId);
    if (existing) {
      // 레포트가 이미 있으면 visualization 확인
      let visualization: VisualizationData | null = null;
      try {
        if (existing.lot_data_json) {
          const parsed = JSON.parse(existing.lot_data_json);
          if (parsed.visualization) {
            visualization = parsed.visualization;
          }
        }
      } catch (e) {
        console.error('[lot-defect-report POST] Failed to parse visualization data:', e);
      }
      
      // visualization이 있고 유효하면 캐시에서 반환 (토큰 절약)
      if (visualization && 
          (visualization.charts?.length > 0 || visualization.tables?.length > 0)) {
        const sanitizedVisualization = sanitizeForJSON(visualization);
        return reply.send({ 
          success: true, 
          lotId, 
          report: existing.report_content, 
          visualization: sanitizedVisualization,
          fromCache: true 
        });
      }
      
      // visualization이 없거나 비어있으면 재생성 (사용자가 명시적으로 POST 요청을 보냄)
      // 이는 사용자가 레포트를 열었는데 visualization이 없을 때 발생
      // 기존 레포트는 무시하고 새로 생성 (아래 코드 계속 실행)
    }

    try {
      // 레포트가 없을 때만 새로 생성 (토큰 사용)
      const { textReport, visualization } = await generateDefectReport(lotId, lotData, language);
      
      request.log.info({ 
        lotId,
        hasVisualization: !!visualization,
        chartsCount: visualization?.charts?.length || 0,
        tablesCount: visualization?.tables?.length || 0,
        reportLength: textReport.length
      }, 'Generated defect report with visualization');
      
      // Infinity/NaN 값 제거 후 저장 및 반환
      const sanitizedLotData = sanitizeForJSON({ 
        ...lotData, 
        lotId, 
        visualization 
      });
      const sanitizedVisualization = sanitizeForJSON(visualization);
      
      await saveReportToDb(lotId, textReport, sanitizedLotData);
      
      return reply.send({ 
        success: true, 
        lotId, 
        report: textReport,
        visualization: sanitizedVisualization
      });
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      request.log.error({ err: e }, 'Lot defect report generation failed');
      
      // OpenAI API 관련 에러 메시지 개선
      let errorMessage = msg;
      if (msg.includes('OPENAI_API_KEY') || msg.includes('API key') || msg.includes('Invalid API key')) {
        errorMessage = 'OpenAI API 키가 설정되지 않았거나 유효하지 않습니다.';
      } else if (msg.includes('quota') || msg.includes('429') || msg.includes('rate_limit')) {
        errorMessage = 'OpenAI API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.';
      } else if (msg.includes('network') || msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
        errorMessage = 'OpenAI API 서버에 연결할 수 없습니다. 네트워크를 확인해주세요.';
      }
      
      return reply.code(500).send({ success: false, error: errorMessage });
    }
  });
}
