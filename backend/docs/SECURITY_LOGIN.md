# 보안 로그인 시스템

manufacturing_db의 users 테이블을 기반으로 한 엔터프라이즈급 보안 로그인입니다.

## 보안 구성 요소

### 1. 비밀번호 해싱 (bcrypt)
- **회원가입/시드**: `bcrypt.hash(password, 10)` — salt rounds 10
- **로그인 검증**: `bcrypt.compare(plain, hashed)`
- DB에 저장되는 것은 해시값만 저장되어, DB 유출 시에도 원본 비밀번호는 보호됨

### 2. JWT + HttpOnly 쿠키
- 로그인 성공 시 `auth_token` HttpOnly 쿠키에 JWT 저장
- **XSS 방지**: HttpOnly로 JavaScript 접근 불가
- **유효기간**: 7일 (lib/jwt.ts에서 조정 가능)

### 3. Next.js Middleware
- 보호된 경로 접근 시 쿠키의 JWT 검증
- 미인증 사용자 → `/login` 리다이렉트
- 만료/위조 토큰 → 쿠키 삭제 후 로그인 페이지로 이동

### 4. 사원번호 검증
- **8자리 숫자** 필수 (L&F 사번 체계)
- 프론트엔드: `maxLength={8}`, `pattern`, 숫자만 입력
- 유효하지 않으면 서버 요청 전 차단

## 환경 변수 (.env.local)

```env
JWT_SECRET=your-strong-random-secret-change-in-production
```

**배포 시**: 32자 이상의 랜덤 문자열로 변경 권장

## 권한 (RBAC)

- `role`: `admin` | `user`
- `isAdmin` 컨텍스트로 관리자 전용 UI 분기 가능
