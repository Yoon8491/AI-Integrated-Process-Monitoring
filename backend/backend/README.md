# manufacturing-dashboard-backend

Fastify 기반 API 서버입니다. 프론트(Next.js/Vercel)와 분리 운영을 전제로 합니다.

## 로컬 실행

```bash
cd backend
npm install
npm run dev
```

기본 포트는 `4000` 입니다.

## 환경변수

`.env`(또는 시스템 환경변수)로 설정합니다. 예시는 `.env.example` 참고.

필수/권장:
- `JWT_SECRET`: JWT 서명 키
- `CORS_ORIGIN`: 허용할 프론트 Origin (기본: `https://azas-project.vercel.app`)
- `AUTH_DB_*`: users / lot_defect_reports 테이블이 있는 DB (미설정 시 `DB_*` 사용)
- **공정 데이터(대시보드)**: MariaDB `project` DB의 `preprocessing` 테이블을 쓰려면  
  **`DB_NAME=project`** 또는 **`PROCESS_DB_NAME=project`** 를 반드시 설정하세요.  
  `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`는 MariaDB 접속 정보로 맞춰 주세요.
- `OPENAI_API_KEY`: LOT 불량 리포트 및 챗봇에 필요
- `OPENAI_MODEL_NAME`: OpenAI 모델명 (기본값: gpt-4o-mini)

## 대시보드에 데이터가 안 뜰 때 (Lightsail + project.preprocessing)

1. **백엔드 서버(Lightsail) 환경변수**  
   - `DB_NAME=project` 또는 `PROCESS_DB_NAME=project`  
   - `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`가 MariaDB 접속에 맞는지 확인
2. **MariaDB**  
   - `project` DB 존재, `preprocessing` 테이블 존재  
   - 백엔드에서 쓰는 DB 사용자에게 `project` DB 접근 권한이 있는지 확인
3. **방화벽**  
   - Lightsail에서 백엔드 포트(예: 4000) 열려 있는지, Vercel 프론트에서 해당 URL로 요청 가능한지 확인
4. **Vercel**  
   - `NEXT_PUBLIC_API_BASE_URL`이 백엔드 HTTPS 주소(예: `https://<Lightsail-IP 또는 도메인>:4000` 또는 터널 URL)로 설정되어 있는지 확인

## 프론트 연결

프론트(Next.js)에서 아래 환경변수를 설정합니다.

- `NEXT_PUBLIC_API_BASE_URL=https://<backend-https-url>`

예: Cloudflare Quick Tunnel 사용 시 터널이 만들어주는 `https://....trycloudflare.com` 를 넣으면 됩니다.

## HTTPS (도메인 없이 빠르게)

Vercel 프론트에서 Mixed Content 없이 호출하려면 **백엔드도 HTTPS**여야 합니다.

가장 쉬운 방법: Cloudflare Quick Tunnel

```bash
cloudflared tunnel --url http://localhost:4000
```

출력되는 `https://....trycloudflare.com` 를 `NEXT_PUBLIC_API_BASE_URL`로 사용하세요.

## 모델 학습 및 대시보드 연동

대시보드의 "불량 원인 분석 레포트"에 **스태킹 모델(XGB+LGBM+RF) feature importance**를 반영하려면 아래 단계를 따르세요.

### 1. DB에서 학습용 CSV 내보내기

```bash
cd backend
npx tsx scripts/export-training-data.ts [출력 경로]
```

- 출력 경로를 생략하면 기본값: `../minseo/backend/fastapi/data/training_export.csv`
- 공정 DB의 테이블(`simulation_results` 등)에서 최대 50,000건을 CSV로 내보냅니다.
- 필수 컬럼: `lot_id`, `timestamp`, `d50`, `metal_impurity`, `lithium_input`, `additive_ratio`, `process_time`, `sintering_temp`, `humidity`, `operator_id`, `tank_pressure`, `quality_defect`

### 2. 모델 학습 실행

```bash
cd backend
./scripts/train-and-update-model.sh [CSV 경로]
```

- CSV 경로를 생략하면 자동으로 `../minseo/backend/fastapi/data/training_export.csv` 사용
- 내부적으로 `minseo/backend/fastapi/train_model.py`를 실행합니다.
- 학습 완료 후 `model_feature_importance.json`을 `backend/model/`로 자동 복사합니다.

**전체 흐름 (한 번에)**:

```bash
cd backend
npx tsx scripts/export-training-data.ts
./scripts/train-and-update-model.sh
npm run dev  # 백엔드 재시작
```

### 3. 백엔드가 모델 중요도 파일을 찾는 경로

백엔드는 다음 순서로 `model_feature_importance.json`을 찾습니다.

1. 환경변수: `MODEL_FEATURE_IMPORTANCE_JSON_PATH` (절대 경로 지정 가능)
2. `backend/model/model_feature_importance.json` (기본 위치)
3. `../../minseo/backend/fastapi/model/model_feature_importance.json` (minseo가 형제 폴더일 때)

파일이 있으면 **"불량 원인별 영향도 (스태킹 모델 XGB+LGBM+RF)"** 로 표시되고,  
파일이 없으면 **"불량 원인별 영향도 (LightGBM 분석)"** (DB 통계 기반)으로 폴백됩니다.

### 4. 수동으로 학습하고 싶을 때

`minseo/backend/fastapi/train_model.py`를 직접 실행해도 됩니다.

```bash
cd minseo/backend/fastapi
python train_model.py --csv data/your_data.csv --output model/model.joblib
```

학습 완료 후 생성된 `model/model_feature_importance.json`을 백엔드 `model/` 폴더로 복사하면 됩니다.

```bash
cp model/model_feature_importance.json ../../backend/backend/model/
```

