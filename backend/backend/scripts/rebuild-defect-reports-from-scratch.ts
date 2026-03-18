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

import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { generateDefectReport, renumberLotReportIds } from '../src/routes/dashboard/lot-defect-report.js';

// 연결 풀 생성 (재사용 가능)
let processPool: mysql.Pool | null = null;

function getProcessPool(): mysql.Pool {
  if (!processPool) {
    processPool = mysql.createPool({
      host: config.processDb.host,
      port: config.processDb.port,
      user: config.processDb.user,
      password: config.processDb.password,
      database: config.processDb.database,
      connectTimeout: 10000,
      waitForConnections: true,
      connectionLimit: 5, // 스크립트용으로 작은 풀
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
    
    processPool.on('error', (err) => {
      console.error('Process DB pool error:', err);
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        processPool = null; // 재생성하도록 설정
      }
    });
  }
  return processPool;
}

/** 스캔마다 연결 풀에서 연결 가져오기 */
async function createProcessConnection(): Promise<mysql.PoolConnection> {
  const pool = getProcessPool();
  return pool.getConnection();
}

const SOURCE_TABLE = process.env.SCHEDULER_DEFECT_TABLE || process.env.PROCESS_TABLE_NAME || 'simulation_defects_only';
const SIX_PARAM_NAMES = ['리튬 투입량', '첨가제 비율', '공정 시간', '습도', '탱크 압력', '소결 온도'];

function hasNewFormat(reportContent: string): boolean {
  if (!reportContent || typeof reportContent !== 'string') return false;
  if (!reportContent.includes('**불량 원인 분석**') && !reportContent.includes('불량 원인 분석')) return false;
  const n = SIX_PARAM_NAMES.filter((name) => reportContent.includes(name)).length;
  return n >= 6;
}

interface LotData {
  lot_id: string;
  lithium_input: number | null;
  additive_ratio: number | null;
  process_time: number | null;
  humidity: number | null;
  tank_pressure: number | null;
  sintering_temp: number | null;
  prediction: number;
  timestamp: string;
}

const INTERVAL_MS = 10 * 60 * 1000; // 10분

let scanCount = 0;

/** DB timestamp 컬럼용 형식 (YYYY-MM-DD HH:MM:SS) */
function toMysqlDatetime(v: unknown): string {
  if (!v) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  const d = new Date(v as string | number | Date);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** simulation_results 스캔 → 없으면 생성, 6개 파라미터 없으면 대체, 있으면 스킵 */
async function scanAndProcessReports() {
  scanCount++;
  const conn = await createProcessConnection();
  const now = new Date().toISOString();
  console.log(`\n[${now}] 🔍 ${SOURCE_TABLE} 스캔 시작...`);

  try {
    // 1. simulation_results에서 불량 LOT 조회 (lot_id별 최초 1개, prediction=1)
    //    lot_id가 있는 행만 대상 (없으면 스킵)
    const [defectRows]: any = await conn.query(`
      SELECT s.lot_id, s.lithium_input, s.additive_ratio, s.process_time,
             s.humidity, s.tank_pressure, s.sintering_temp, s.prediction, s.timestamp
      FROM ${SOURCE_TABLE} s
      INNER JOIN (
        SELECT lot_id, MIN(timestamp) as min_ts
        FROM ${SOURCE_TABLE}
        WHERE prediction = 1 AND lot_id IS NOT NULL AND TRIM(lot_id) != ''
        GROUP BY lot_id
      ) m ON s.lot_id = m.lot_id AND s.timestamp = m.min_ts
      WHERE s.prediction = 1
      ORDER BY s.timestamp ASC
    `);

    const defectLots: LotData[] = (defectRows || []).map((r: any) => ({
      lot_id: String(r.lot_id).trim(),
      lithium_input: r.lithium_input ?? null,
      additive_ratio: r.additive_ratio ?? null,
      process_time: r.process_time ?? null,
      humidity: r.humidity ?? null,
      tank_pressure: r.tank_pressure ?? null,
      sintering_temp: r.sintering_temp ?? null,
      prediction: r.prediction,
      timestamp: r.timestamp ? String(r.timestamp) : new Date().toISOString()
    }));

    if (defectLots.length === 0) {
      console.log(`   불량 LOT 없음`);
      return;
    }

    // 2. lot_defect_reports 기존 데이터 (report_content로 6개 파라미터 여부 판별)
    const [existingRows]: any = await conn.query(
      `SELECT lot_id, report_content FROM lot_defect_reports`
    );
    const existingMap = new Map<string, string>();
    (existingRows || []).forEach((r: any) => {
      existingMap.set(r.lot_id, r.report_content || '');
    });

    // 3. 분류: 생성 / 대체 / 스킵
    const toCreate: LotData[] = [];
    const toReplace: LotData[] = [];
    let skipCount = 0;
    for (const lot of defectLots) {
      const content = existingMap.get(lot.lot_id);
      if (!content) toCreate.push(lot);
      else if (!hasNewFormat(content)) toReplace.push(lot);
      else skipCount++;
    }

    console.log(`   생성: ${toCreate.length}개, 대체: ${toReplace.length}개, 스킵: ${skipCount}개`);

    let createOk = 0, createFail = 0, replaceOk = 0, replaceFail = 0;
    const toLotData = (lot: LotData) => ({
      lot_id: lot.lot_id,
      lotId: lot.lot_id,
      lithiumInput: lot.lithium_input,
      addictiveRatio: lot.additive_ratio,
      processTime: lot.process_time,
      humidity: lot.humidity,
      tankPressure: lot.tank_pressure,
      sinteringTemp: lot.sintering_temp,
      params: {
        lithiumInput: lot.lithium_input,
        addictiveRatio: lot.additive_ratio,
        processTime: lot.process_time,
        humidity: lot.humidity,
        tankPressure: lot.tank_pressure,
        sinteringTemp: lot.sintering_temp
      }
    });

    // 4. 없는 LOT → 생성
    for (let i = 0; i < toCreate.length; i++) {
      const lot = toCreate[i];
      const lotId = lot.lot_id;
      const progress = `[생성 ${i + 1}/${toCreate.length}]`;

      try {
        console.log(`   ${progress} ${lotId} 레포트 생성 중...`);
        const lotData = toLotData(lot);
        const result = await generateDefectReport(lotId, lotData, 'ko');

        const lotDataJson = {
          ...lotData,
          lotId,
          visualization: result.visualization
        };

        await conn.query(
          `INSERT INTO lot_defect_reports 
            (id, lot_id, report_content, lot_data_json, timestamp)
          VALUES (0, ?, ?, ?, ?)`,
          [lotId, result.textReport, JSON.stringify(lotDataJson), toMysqlDatetime(lot.timestamp)]
        );

        console.log(`   ${progress} ✅ ${lotId} 저장 완료`);
        createOk++;

        await new Promise((r) => setTimeout(r, 1000));
      } catch (error) {
        console.error(`   ${progress} ❌ ${lotId} 오류:`, error);
        createFail++;
      }
    }

    // 5. 6개 파라미터 없는 LOT → 대체
    for (let i = 0; i < toReplace.length; i++) {
      const lot = toReplace[i];
      const progress = `[대체 ${i + 1}/${toReplace.length}]`;
      try {
        console.log(`   ${progress} ${lot.lot_id} 새 양식으로 대체 중...`);
        const lotData = toLotData(lot);
        const result = await generateDefectReport(lot.lot_id, lotData, 'ko');
        const lotDataJson = { ...lotData, lotId: lot.lot_id, visualization: result.visualization };
        await conn.query(
          `UPDATE lot_defect_reports SET report_content = ?, lot_data_json = ? WHERE lot_id = ?`,
          [result.textReport, JSON.stringify(lotDataJson), lot.lot_id]
        );
        console.log(`   ${progress} ✅ ${lot.lot_id} 대체 완료`);
        replaceOk++;
      } catch (err) {
        console.error(`   ${progress} ❌ ${lot.lot_id} 오류:`, err);
        replaceFail++;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    await renumberLotReportIds(); // 생성/대체 시 id 즉시 부여, 기존 id=0 보정
    console.log(`   id 재정렬 완료`);

    console.log(
      `[${new Date().toISOString()}] ✅ 완료: 생성 ${createOk}/${toCreate.length}, 대체 ${replaceOk}/${toReplace.length}, 스킵 ${skipCount}\n`
    );
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ 스캔 중 오류:`, error);
  } finally {
    conn.release(); // 연결 풀에 반환
  }
}

async function run() {
  console.log('🚀 lot_defect_reports 10분 주기 스캔');
  console.log(`   테이블: ${SOURCE_TABLE} | 없으면 생성, 6개 파라미터 없으면 대체, 있으면 스킵`);
  console.log(`   주기: ${INTERVAL_MS / 60000}분\n`);

  await scanAndProcessReports();

  setInterval(() => scanAndProcessReports(), INTERVAL_MS);
}

run().catch(console.error);
