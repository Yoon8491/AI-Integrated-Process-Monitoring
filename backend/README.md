# Manufacturing Dashboard - Backend

제조 공정 대시보드 백엔드 (Fastify + FastAPI)

## 구조

- `backend/` - Fastify 백엔드 (Node.js/TypeScript)
- `backend_fastapi/` - FastAPI 백엔드 (Python)
- `database/` - 데이터베이스 스크립트

## Fastify 백엔드 (Node.js)

### 설치 및 실행

```bash
cd backend
npm install
npm run dev  # 개발 모드 (포트 4000)
npm run build && npm start  # 프로덕션 모드
```

### 환경 변수

`backend/.env` 파일을 생성하고 `.env.example`을 참고하세요.

## FastAPI 백엔드 (Python)

### 설치 및 실행

```bash
cd backend_fastapi
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 4000 --reload  # 개발 모드
```

### 환경 변수

`backend_fastapi/.env` 파일을 생성하고 `.env.example`을 참고하세요.

## 데이터베이스

MariaDB/MySQL 데이터베이스가 필요합니다. `database/` 폴더의 SQL 스크립트를 참고하세요.

## API 엔드포인트

- `POST /auth/login` - 로그인
- `POST /auth/signup` - 회원가입
- `GET /dashboard/summary` - 대시보드 요약
- `GET /dashboard/calendar-month` - 캘린더 데이터
- `GET /dashboard/alerts` - 알림 목록
- `GET /dashboard/realtime` - 실시간 센서 데이터
- 기타 대시보드 관련 엔드포인트

## CORS 설정

프론트엔드 URL을 `CORS_ORIGIN` 환경 변수에 설정하세요.
