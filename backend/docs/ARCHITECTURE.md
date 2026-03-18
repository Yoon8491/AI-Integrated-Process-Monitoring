# 아키텍처 개요 (Frontend / Backend 분리)

## 구성

- Frontend: Next.js (Vercel 배포)
  - UI 렌더링 + API 호출
  - `NEXT_PUBLIC_API_BASE_URL`로 백엔드 주소를 주입
- Backend: Fastify (`backend/`)
  - `/api/**` 엔드포인트 제공
  - CORS 허용(기본: `https://azas-project.vercel.app`)
  - 인증: `Authorization: Bearer <jwt>`

## 데이터 흐름

1) 사용자가 프론트에서 로그인
2) 프론트 → 백엔드 `/api/auth/login`
3) 백엔드가 `{ token, user }` 반환
4) 프론트가 token을 저장(localStorage)하고, 이후 요청에 `Authorization` 헤더로 포함
5) 대시보드/분석 화면은 `/api/dashboard/*`를 백엔드로 호출

## 로컬 포트

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:4000`

## 운영 시 주의(HTTPS)

Vercel은 HTTPS이므로, 브라우저에서 백엔드가 HTTP면 Mixed Content로 막힙니다.

- 운영 환경에서는 백엔드도 **반드시 HTTPS**로 노출하세요.
- 도메인 없이 빠르게 HTTPS를 쓰려면 Cloudflare Quick Tunnel을 사용할 수 있습니다.

