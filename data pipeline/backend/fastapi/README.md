# minseo FastAPI - 불량 영향 변수 & 예측

## 역할

- **`GET /api/probability-correlation`**: 전처리+모델 기반 6개 파라미터 vs probability Pearson 상관계수
- **`POST /predict`**: 불량 확률 예측

Analytics 대시보드의 "불량 영향 변수 Top 6"에 이 API 값이 사용됩니다.

## 실행 방법

```bash
# minseo/backend/fastapi 디렉토리에서
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

또는 (Python 직접 실행):

```bash
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## 실행 순서 (로컬 개발)

1. **minseo FastAPI** (포트 8000)
2. **Backend** (포트 4000)
3. **Frontend** (포트 3000)

```powershell
# 터미널 1: minseo
cd minseo\backend\fastapi
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000

# 터미널 2: backend
cd backend\backend
npm run dev

# 터미널 3: frontend
cd frontend
npm run dev
```

## 환경 변수

- DB 설정: `backend/backend/.env`에서 로드 (analyze_probability_correlation.py)
- `PROCESS_TABLE_NAME`: 기본 `simulation_results`
- 모델 경로: `model/model.joblib` (같은 디렉토리)

## 대시보드 연동

- Backend `.env`에 `MINSEO_API_URL=http://localhost:8000` 설정 시 analytics가 이 API를 호출
- 미설정 또는 호출 실패 시 DB 기반 Pearson fallback 사용
