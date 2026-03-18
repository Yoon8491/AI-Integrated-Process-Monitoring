# LOT 불량 레포트 생성 시스템 전체 가이드

## 📁 파일 구조

```
backend/backend/
├── src/routes/dashboard/lot-defect-report.ts   # 🔴 핵심: 레포트 생성 로직, API, DB
├── scripts/
│   ├── rebuild-defect-reports-from-scratch.ts # 10분 주기 스캔 (메인 생성 경로)
│   ├── refresh-legacy-reports.ts              # 구 양식 → 새 양식 일괄 대체
│   ├── renumber-ids-once.ts                   # id 재정렬 1회 실행
│   ├── reorder-defect-reports.ts              # timestamp 기준 전체 재정렬
│   ├── analyze-defect-reports.ts              # 레포트 분석
│   └── check-duplicate-lots.ts                # 중복 LOT 확인
├── model/model_feature_importance.json        # ML 모델 영향도 (차트용)
└── docs/LOT_DEFECT_REPORT_FORMAT.md           # 레포트 양식 상세

frontend/
├── app/lot-status/page.tsx                    # LOT 현황 + 레포트 모달
├── app/api/dashboard/lot-defect-report/route.ts # GET/POST 프록시
├── app/api/dashboard/lot-defect-reports/ensure/route.ts # 레포트 유무 확인
└── lib/lot-report.ts                          # (deprecated) 백엔드로 전환됨
```

---

## 1. 레포트 생성 흐름 (전체)

```
[simulation_results / simulation_defects_only]
         │
         ▼
  rebuild-defect-reports-from-scratch.ts (10분마다)
         │
         ├─▶ lot_defect_reports에 없는 lot_id → INSERT (generateDefectReport 호출)
         ├─▶ 6개 파라미터 없는 구 레포트 → UPDATE (generateDefectReport 호출)
         └─▶ 새 양식 레포트 → 스킵
         │
         ▼
  renumberLotReportIds() → id를 timestamp 순으로 재할당
```

**중요: API POST로 레포트 생성 안 함.** `REPORTS_API_DISABLED = true`로 403 반환.

---

## 2. 핵심 함수: generateDefectReport

**위치:** `backend/backend/src/routes/dashboard/lot-defect-report.ts`

### 2-1. 입력

- `lotId`: LOT 식별자 (예: LOT-20260213-00513)
- `lotData`: 6개 파라미터 + params
  ```ts
  {
    lotId, lot_id, lithiumInput, addictiveRatio, processTime,
    humidity, tankPressure, sinteringTemp,
    params: { lithiumInput, addictiveRatio, ... }
  }
  ```
- `language`: 'ko' | 'en'

### 2-2. 처리 단계

1. **정상 범위 계산** (`calculateNormalRanges`)
   - `data_sample` (또는 COMPARISON_TABLE_NAME) 테이블 사용
   - quality_defect 0=합격, 1=불량
   - 합격/불량 LOT 평균, 표준편차, 정상범위(평균±2σ) 계산

2. **모델 영향도 로드** (`loadModelFeatureImportance`)
   - `model/model_feature_importance.json` (train_model.py에서 생성)
   - base_feature_importance 배열 → x_columns와 매핑

3. **시각화 데이터 생성** (`analyzeDefectCauses`)
   - 6개 파라미터: 리튬 투입량, 첨가제 비율, 공정 시간, 습도, 탱크 압력, 소결 온도
   - Z-score·편차 + Feature Importance로 영향도 계산
   - 합계 100%로 정규화, 최고 영향도는 빨간색(#ef4444)
   - 비전공자용 문구: `formatStatsForNonExpert`

4. **OpenAI API 호출** (gpt-4o-mini)
   - system: "배터리 전극 제조 공정 분석 전문가..."
   - user: LOT 데이터 + 분석 요약 + "**불량 원인 분석**", "**불량 발생 메커니즘**", "**권장 조치사항**" 양식
   - 실패 시 fallback 텍스트 생성 (토큰 사용 안 함)

### 2-3. 출력

```ts
{ textReport: string; visualization: VisualizationData }
```

- `textReport`: 마크다운 형식 불량 원인 분석
- `visualization`: charts, tables, statistics (차트/테이블용)

---

## 3. rebuild-defect-reports-from-scratch.ts (10분 주기)

### 3-1. 설정

- **SOURCE_TABLE**: `process.env.PROCESS_TABLE_NAME` 또는 `simulation_defects_only`
- **주기**: 10분

### 3-2. 로직

1. SOURCE_TABLE에서 `prediction=1` 불량 LOT 조회 (lot_id별 최초 1개)
2. `lot_id`가 NULL/빈 값인 행은 스킵
3. `lot_defect_reports` 조회 → report_content로 6개 파라미터 포함 여부 판별
4. 분류:
   - **toCreate**: 레포트 없음 → INSERT
   - **toReplace**: 구 양식(6개 파라미터 없음) → UPDATE
   - **스킵**: 새 양식 → 아무것도 안 함
5. 생성/대체 후 `renumberLotReportIds()` 호출

### 3-3. 실행

```bash
cd backend/backend
npx tsx scripts/rebuild-defect-reports-from-scratch.ts
```

---

## 4. refresh-legacy-reports.ts (일괄 대체)

- `lot_defect_reports` 전부 조회
- `hasNewFormat(report_content)` = false 인 것만 새 양식으로 재생성
- lot_data_json에서 6개 파라미터 추출 → `generateDefectReport` → UPDATE

```bash
npx tsx scripts/refresh-legacy-reports.ts
```

---

## 5. renumber-ids-once.ts (id 재정렬)

- `ROW_NUMBER() OVER (ORDER BY timestamp ASC)`로 id 재할당
- id=0인 행 등 기존 잘못된 id 보정

```bash
npx tsx scripts/renumber-ids-once.ts
```

---

## 6. reorder-defect-reports.ts (전체 재정렬)

- DELETE 후 timestamp 순으로 1번부터 다시 INSERT
- 대량 수정 시 사용

---

## 7. DB 테이블: lot_defect_reports

| 컬럼          | 타입         | 설명                    |
|---------------|--------------|-------------------------|
| id            | INT          | timestamp 순서 번호    |
| lot_id        | VARCHAR(100) | PK                      |
| report_content| TEXT         | 마크다운 텍스트         |
| lot_data_json | JSON         | lotData + visualization |
| timestamp     | TIMESTAMP    | LOT 기준 시각           |

---

## 8. 프론트엔드 흐름

### 8-1. LOT 현황 (lot-status/page.tsx)

1. `/api/dashboard/lot-status` → 불량 LOT 목록
2. LOT 클릭 시 `/api/dashboard/lot-defect-report?lotId=xxx` GET
3. 404 → "10분 후 자동으로 레포트 생성됩니다" 표시
4. 200 → report_content + visualization 렌더링

### 8-2. API 프록시 (app/api/dashboard/lot-defect-report/route.ts)

- GET: 백엔드 `GET /api/dashboard/lot-defect-report?lotId=xxx` 프록시
- POST: 백엔드 POST 전달 → 현재 403 (레포트 생성 비활성화)

---

## 9. 양식 (6개 파라미터)

- 리튬 투입량 (lithium_input)
- 첨가제 비율 (additive_ratio)
- 공정 시간 (process_time)
- 습도 (humidity)
- 탱크 압력 (tank_pressure)
- 소결 온도 (sintering_temp)

`hasNewFormat()`: report_content에 "불량 원인 분석" + 위 6개 이름이 모두 포함되어 있으면 true.

---

## 10. 환경 변수

| 변수                   | 설명                          |
|------------------------|-------------------------------|
| PROCESS_TABLE_NAME     | 스캔 테이블 (기본: simulation_results) |
| COMPARISON_TABLE_NAME   | 정상 범위 계산용 (기본: data_sample)   |
| OPENAI_API_KEY         | gpt-4o-mini 호출용            |
| OPENAI_MODEL_NAME      | 모델명 (기본: gpt-4o-mini)    |
| MODEL_FEATURE_IMPORTANCE_JSON_PATH | 영향도 JSON 경로 |

---

## 11. 토큰/비용 (gpt-4o-mini)

- 레포트 1개당: ~1,500 토큰 (입력 ~950, 출력 ~580)
- 비용: 레포트 1개당 약 $0.0005 (0.65원)
- 108개 대체 시: 약 $0.05 (70원)

---

## 12. 요약

| 구분           | 담당                           |
|----------------|--------------------------------|
| 레포트 생성    | `rebuild-defect-reports-from-scratch.ts`만 |
| API POST       | 403 (생성 비활성화)            |
| 레포트 조회    | GET /api/dashboard/lot-defect-report      |
| 시각화         | 코드 내 계산 (OpenAI 사용 안 함)           |
| 텍스트         | OpenAI gpt-4o-mini             |
| id 재정렬      | 매 스캔마다 자동 실행          |
