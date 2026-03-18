# 내일 작업 가이드

## 🎯 목표
- 하나의 lot_id당 하나의 report만 유지
- 8개 feature 모델 사용 (파생변수 없음)
- Stacking Model 기반 시각화

---

## 📋 작업 순서

### 1단계: 테이블 초기화
```sql
-- 기존 테이블 삭제 (중복 데이터 제거)
DROP TABLE IF EXISTS lot_defect_reports;

-- 올바른 구조로 재생성 (id=시계열 1번부터, timestamp 기준 오래된 순)
CREATE TABLE lot_defect_reports (
  id INT NOT NULL DEFAULT 0,
  lot_id VARCHAR(100) NOT NULL PRIMARY KEY,
  report_content TEXT NOT NULL,
  lot_data_json JSON,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_id (id),
  INDEX idx_timestamp (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

### 2단계: 모델 학습 (선택)
```bash
# 필요시 재학습 (현재 모델 사용해도 됨)
cd /home/ubuntu/backend/backend
npx tsx scripts/export-training-data.ts
./scripts/train-and-update-model.sh /tmp/training_export.csv
```

---

### 3단계: 데이터 채우기 스크립트 작성
```typescript
// fill-defect-reports.ts (새로 작성)

// 1. simulation_results에서 불량 LOT 조회
// 2. 각 LOT에 대해:
//    - 8개 feature 데이터 가져오기
//    - Feature Importance 계산 (모델에서)
//    - visualizations 생성 (정상범위 비교)
//    - OpenAI로 report_content 생성
//    - INSERT ... ON DUPLICATE KEY UPDATE
// 3. 결과: 하나의 lot_id = 하나의 report
```

---

## 🎨 최종 데이터 구조

### lot_defect_reports 테이블
```
┌──────────────────┬───────────────────────────┐
│ lot_id (UNIQUE)  │ LOT-20260202-08945        │
├──────────────────┼───────────────────────────┤
│ report_content   │ "요약: 습도 이상..."      │
├──────────────────┼───────────────────────────┤
│ lot_data_json    │ {"lithium_input": 2.75,   │
│                  │  "humidity": 4.71, ...}   │
├──────────────────┼───────────────────────────┤
│ defect_causes    │ {"features": [            │
│                  │   "lithium_input",        │
│                  │   "humidity", ...],       │
│                  │  "importance": [          │
│                  │   0.152, 0.128, ...]}     │
├──────────────────┼───────────────────────────┤
│ visualizations   │ {"parameters": [          │
│                  │   {"name": "습도",        │
│                  │    "value": "4.71",       │
│                  │    "status": "warning"}]} │
└──────────────────┴───────────────────────────┘
```

---

## ✅ 체크리스트

- [ ] 기존 테이블 삭제
- [ ] UNIQUE 제약 있는 테이블 생성
- [ ] 8개 feature 모델 사용 확인
- [ ] ON DUPLICATE KEY UPDATE 적용
- [ ] 중복 없이 데이터 채우기
- [ ] 프론트엔드에서 시각화 확인

---

## 📚 참고 파일

- 모델 정의: `/home/ubuntu/backend/backend/scripts/user-model-definition.py`
- Feature Importance: `/home/ubuntu/backend/backend/model/model_feature_importance.json` (재생성 필요)
- 학습된 모델: `/home/ubuntu/minseo/backend/fastapi/model/model.joblib` (재학습 필요)

---

## 🚀 예상 결과

```sql
SELECT lot_id, COUNT(*) as count 
FROM lot_defect_reports 
GROUP BY lot_id 
HAVING COUNT(*) > 1;

-- Empty set (0 rows)  ✅ 중복 없음!
```

**하나의 lot_id = 하나의 report!** 🎯
