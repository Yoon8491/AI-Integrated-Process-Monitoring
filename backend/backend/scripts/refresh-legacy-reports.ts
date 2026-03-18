/**
 * report_content에 6개 파라미터(리튬 투입량, 첨가제 비율, 공정 시간, 습도, 탱크 압력, 소결 온도)가
 * 없는 구 양식 레포트를 새 양식으로 재생성하여 대체합니다.
 *
 * 실행: npx tsx scripts/refresh-legacy-reports.ts
 */

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
import { generateDefectReport } from '../src/routes/dashboard/lot-defect-report.js';

const SIX_PARAM_NAMES = [
  '리튬 투입량',
  '첨가제 비율',
  '공정 시간',
  '습도',
  '탱크 압력',
  '소결 온도',
];

/** report_content가 새 양식(6개 파라미터 포함)인지 판별 */
function hasNewFormat(reportContent: string): boolean {
  if (!reportContent || typeof reportContent !== 'string') return false;
  const lower = reportContent;
  // **불량 원인 분석** 섹션과 6개 파라미터가 모두 포함되어 있는지
  if (!lower.includes('**불량 원인 분석**') && !lower.includes('불량 원인 분석')) return false;
  const paramCount = SIX_PARAM_NAMES.filter((name) => lower.includes(name)).length;
  return paramCount >= 6;
}

/** lot_data_json에서 lotData 추출 (generateDefectReport 형식) */
function extractLotData(lotId: string, lotDataJson: unknown): Record<string, unknown> | null {
  if (!lotDataJson || typeof lotDataJson !== 'object') return null;
  const raw = lotDataJson as Record<string, unknown>;
  const params = (raw.params as Record<string, number>) || {};
  return {
    lotId,
    lot_id: lotId,
    lithiumInput: raw.lithiumInput ?? raw.lithium_input ?? params.lithiumInput ?? null,
    addictiveRatio: raw.addictiveRatio ?? raw.additive_ratio ?? params.addictiveRatio ?? null,
    processTime: raw.processTime ?? raw.process_time ?? params.processTime ?? null,
    humidity: raw.humidity ?? params.humidity ?? null,
    tankPressure: raw.tankPressure ?? raw.tank_pressure ?? params.tankPressure ?? null,
    sinteringTemp: raw.sinteringTemp ?? raw.sintering_temp ?? params.sinteringTemp ?? null,
    recordCount: raw.recordCount ?? raw.record_count ?? null,
    latestDate: raw.latestDate ?? raw.latest_date ?? null,
    passFailResult: raw.passFailResult ?? raw.pass_fail_result ?? '불합격',
    params: {
      lithiumInput: raw.lithiumInput ?? raw.lithium_input ?? params.lithiumInput,
      addictiveRatio: raw.addictiveRatio ?? raw.additive_ratio ?? params.addictiveRatio,
      processTime: raw.processTime ?? raw.process_time ?? params.processTime,
      humidity: raw.humidity ?? params.humidity,
      tankPressure: raw.tankPressure ?? raw.tank_pressure ?? params.tankPressure,
      sinteringTemp: raw.sinteringTemp ?? raw.sintering_temp ?? params.sinteringTemp,
    },
  };
}

async function refreshLegacyReports() {
  console.log('🔄 구 양식 report_content → 새 양식(6개 파라미터)으로 대체 시작...\n');

  try {
    const rows = (await authQuery<any[]>(
      `SELECT lot_id, report_content, lot_data_json FROM lot_defect_reports ORDER BY timestamp ASC`
    )) as { lot_id: string; report_content: string; lot_data_json: string | null }[];

    if (!rows || rows.length === 0) {
      console.log('⚠️ 레포트가 없습니다.');
      return;
    }

    const toRefresh = rows.filter((r) => !hasNewFormat(r.report_content));
    console.log(`📊 전체 ${rows.length}개 중 구 양식(대체 대상): ${toRefresh.length}개\n`);

    if (toRefresh.length === 0) {
      console.log('✅ 모두 새 양식입니다. 대체할 레포트가 없습니다.');
      return;
    }

    let success = 0;
    let fail = 0;

    for (let i = 0; i < toRefresh.length; i++) {
      const r = toRefresh[i];
      const lotId = r.lot_id;
      const progress = `[${i + 1}/${toRefresh.length}]`;

      try {
        let lotDataJson: unknown = null;
        try {
          lotDataJson = r.lot_data_json ? JSON.parse(r.lot_data_json) : null;
        } catch {
          console.error(`   ${progress} ${lotId}: lot_data_json 파싱 실패`);
          fail++;
          continue;
        }

        const lotData = extractLotData(lotId, lotDataJson);
        if (!lotData || (lotData.lithiumInput == null && lotData.addictiveRatio == null && lotData.processTime == null)) {
          console.error(`   ${progress} ${lotId}: 6개 파라미터 데이터 부족 (lot_data_json 확인)`);
          fail++;
          continue;
        }

        console.log(`   ${progress} ${lotId} 재생성 중...`);
        const result = await generateDefectReport(lotId, lotData, 'ko');

        const newLotDataJson = {
          ...lotData,
          lotId,
          visualization: result.visualization,
        };

        await authQuery(
          `UPDATE lot_defect_reports SET report_content = ?, lot_data_json = ? WHERE lot_id = ?`,
          [result.textReport, JSON.stringify(newLotDataJson), lotId]
        );

        console.log(`   ${progress} ✅ ${lotId} 대체 완료`);
        success++;

        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        console.error(`   ${progress} ❌ ${lotId} 오류:`, err);
        fail++;
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`✅ 완료: 성공 ${success}개, 실패 ${fail}개`);
    console.log('='.repeat(60));
  } catch (err) {
    console.error('❌ 오류:', err);
  }
}

refreshLegacyReports();
