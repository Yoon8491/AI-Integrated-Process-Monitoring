# AZAS Dashboard API (FastAPI)

FastAPI 기반 백엔드입니다. Next.js 프론트와 동일한 API 경로·응답 형식을 제공합니다.

## 요구 사항

- Python 3.10+
- MariaDB/MySQL (auth용 DB + 공정 데이터용 DB)

## 설치 및 실행

```bash
cd backend_fastapi
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# .env 에 DB 접속 정보·JWT_SECRET·CORS_ORIGIN 설정 후
uvicorn main:app --host 0.0.0.0 --port 4000 --reload
```

## 환경 변수

| 변수 | 설명 |
|------|------|
| PORT | 서버 포트 (기본 4000) |
| CORS_ORIGIN | 허용 Origin (쉼표 구분) |
| JWT_SECRET | JWT 서명 비밀키 |
| AUTH_DB_* | 로그인/회원가입용 DB (users 테이블) |
| DB_* / PROCESS_DB_NAME | 공정 데이터용 DB (preprocessing 등) |
| BACKEND_DATE_TZ | 날짜 기준 타임존 (예: Asia/Seoul) |
| GRAFANA_WEBHOOK_SECRET | (선택) Grafana webhook 인증용. 설정 시 Grafana에서 Authorization: Bearer {값} 헤더 필요 |

## API 경로

- `POST /api/auth/login` - 로그인
- `POST /api/auth/signup` - 회원가입
- `POST /api/auth/update-name` - 이름 변경 (Bearer)
- `GET /api/auth/session` - 세션 확인
- `POST /api/auth/logout` - 로그아웃
- `GET /api/dashboard/summary` - 대시보드 요약
- `GET /api/dashboard/calendar-month` - 캘린더 (year, month)
- `GET /api/dashboard/lot-status` - LOT별 공정 현황 (period, all, debug, noDate)
- `GET /api/dashboard/alerts` - FDC 알림
- `POST /api/grafana/webhook` - Grafana 알람 수신 (MariaDB 저장)
- `GET /api/grafana/alerts` - Grafana 알람 목록 (MariaDB 조회)
- `GET /api/grafana/alerts/latest` - 최신 firing 알람 (폴링/팝업용)
- `GET /api/dashboard/realtime` - 실시간 센서
- `GET /api/dashboard/analytics` - 불량 원인 분석용

## 프론트에서 FastAPI 사용

프론트엔드 `.env.local` 또는 Vercel 환경 변수에 다음을 설정하면 이 FastAPI 서버를 사용합니다.

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
```

배포 시에는 FastAPI 서버의 실제 URL(예: `https://api.example.com`)로 설정합니다.

## Grafana 알람 연동

- Grafana에서 알람 발생 시 **Webhook**으로 `POST /api/grafana/webhook` 호출하면 알람이 **MariaDB**에 저장됩니다.
- 저장 위치: **PROCESS_DB** (현재 사용 중인 DB, 예: `DB_NAME=project`)의 **`grafana_alerts`** 테이블.
- 웹사이트의 "알람 내역" 사이드바와 팝업 알림은 이 테이블을 조회합니다.
- Grafana Contact point URL 예: `http(s)://<백엔드주소>:4000/api/grafana/webhook`
- MariaDB에서 **project** DB(또는 `DB_NAME` / `PROCESS_DB_NAME`에 설정한 DB)를 선택한 뒤 **`grafana_alerts`** 테이블을 확인하세요. (Grafana 알림은 `simulation_defects_only`가 아닌 **`grafana_alerts`**에 저장됩니다.)
- **테이블이 없으면** 웹훅/API 호출 시 자동 생성되며, 수동 생성 시에는 `scripts/create_grafana_alerts_table.sql`을 project DB에서 실행하면 됩니다.

### Grafana 알림이 웹에 안 뜰 때 점검 목록

1. **Contact point URL**: Grafana 알림 채널(Contact point)의 URL이 `http(s)://<백엔드주소>:4000/api/grafana/webhook` 인지 확인 (포트 4000, 경로 `/api/grafana/webhook`).
2. **웹훅 시크릿**: 백엔드 `.env`에 `GRAFANA_WEBHOOK_SECRET`이 있으면 Grafana Contact point의 **HTTP Header**에 `Authorization: Bearer <동일한값>` 추가.
3. **DB 저장**: project DB(또는 `DB_NAME`)에 `grafana_alerts` 테이블이 있고, 알람 발생 후 해당 테이블에 행이 들어가는지 MariaDB에서 확인.
4. **프론트 API 주소**: 웹은 Next.js의 `/api/grafana/alerts`(프록시)로 조회합니다. Next 서버가 백엔드 URL(`BACKEND_URL` 등)로 4000 포트에 접근 가능한지 확인.
5. **브라우저 콘솔**: F12 → Console에서 `[GrafanaAlert] Failed to fetch alerts:` 로그가 있으면 상태 코드와 URL을 확인해 CORS/네트워크/백엔드 오류 구분.

## 불량 LOT 알람 (defect-alerts)

- **불량 레포트**는 project DB의 **`lot_defect_reports`** 테이블에 저장됩니다 (기존 테이블).
- 웹의 "알람 내역" 사이드바에 뜨는 **불량 LOT 알람**은 별도 테이블이 아니라, `lot_defect_reports`를 최근 순으로 조회(`GET /api/dashboard/defect-alerts`)해서 보여주는 것입니다.
