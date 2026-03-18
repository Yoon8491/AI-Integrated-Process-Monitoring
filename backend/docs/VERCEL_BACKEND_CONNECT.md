# Vercel 프론트 ↔ Lightsail 백엔드 연결 가이드

Vercel에 배포한 프론트엔드가 Lightsail 백엔드 데이터를 못 불러올 때 아래를 순서대로 확인하세요.

---

## 1. Vercel 환경 변수 (필수)

프론트엔드는 **백엔드 주소**를 알아야 `/api/dashboard/*` 요청을 보냅니다.

1. [Vercel](https://vercel.com) → 프로젝트 선택 → **Settings** → **Environment Variables**
2. 추가:
   - **Name:** `NEXT_PUBLIC_API_BASE_URL`
   - **Value:** `http://3.34.166.82:4000` (Lightsail 공인 IP + 백엔드 포트)
   - **Environment:** Production, Preview, Development 모두 체크
3. **Save** 후 **Deployments** 탭에서 **Redeploy** (재배포 필수 — 이 변수는 빌드 시 적용됨)

> ⚠️ 값 끝에 슬래시 없이: `http://3.34.166.82:4000` (O) / `http://3.34.166.82:4000/` (X)

---

## 2. Lightsail 방화벽 (포트 4000 열기)

Lightsail 인스턴스에 **인바운드 TCP 4000**이 열려 있어야 인터넷(브라우저)에서 백엔드에 접속할 수 있습니다.

1. AWS Lightsail 콘솔 → **네트워킹(Networking)** 탭
2. 해당 인스턴스의 **방화벽(Firewall)** 또는 **인바운드 규칙**에서:
   - **애플리케이션:** Custom
   - **프로토콜:** TCP
   - **포트:** 4000
   - **소스:** Anywhere (0.0.0.0/0) 또는 필요한 IP만
3. 저장

이후 브라우저에서 `http://3.34.166.82:4000/health` 로 접속해 `{"ok":true}` 가 나오는지 확인하세요.

---

## 3. 백엔드 CORS (Vercel 도메인 허용)

백엔드는 **요청을 보내는 출처(Origin)** 를 허용해야 합니다. Vercel 도메인이 CORS에 포함되어 있어야 합니다.

- 백엔드 서버(Lightsail)의 `.env` 또는 환경 변수:
  - `CORS_ORIGIN=https://당신의-vercel-도메인.vercel.app`
- 여러 도메인일 경우 쉼표로 구분:
  - `CORS_ORIGIN=https://azas-project.vercel.app,https://xxx.vercel.app`
- 기본값이 이미 `https://azas-project.vercel.app` 이면, 그 도메인으로 접속 중이라면 추가 설정 없이 동작합니다.

---

## 4. 동작 확인 순서

1. **백엔드 직접 호출**
   - 브라우저 또는 터미널: `http://3.34.166.82:4000/health`
   - 응답: `{"ok":true}` → 백엔드 + 방화벽 정상

2. **Vercel 사이트**
   - 로그인 후 대시보드 접속
   - 브라우저 개발자 도구(F12) → **Network** 탭
   - `/api/dashboard/summary` 등 요청이 **`http://3.34.166.82:4000`** 로 가는지 확인
   - 안 가면: Vercel에 `NEXT_PUBLIC_API_BASE_URL` 미설정 또는 재배포 안 함
   - CORS 에러면: 백엔드 `CORS_ORIGIN`에 현재 Vercel URL 추가

3. **재배포**
   - `NEXT_PUBLIC_*` 는 **빌드 시** 들어가므로, 환경 변수 추가/수정 후 반드시 **Redeploy** 해야 적용됩니다.

---

## 요약 체크리스트

| 항목 | 확인 |
|------|------|
| Vercel에 `NEXT_PUBLIC_API_BASE_URL=http://3.34.166.82:4000` 설정 | ☐ |
| 설정 후 Redeploy 실행 | ☐ |
| Lightsail 방화벽에서 TCP 4000 허용 | ☐ |
| 백엔드 CORS에 Vercel 도메인 포함 | ☐ |
| `http://3.34.166.82:4000/health` 브라우저에서 `{"ok":true}` 확인 | ☐ |
