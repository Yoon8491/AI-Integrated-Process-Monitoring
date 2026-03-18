# Superset (minseo Docker)

Apache Superset가 `docker-compose.yml`에 포함되어 있습니다.

## 실행

```bash
cd minseo
docker compose up -d superset-db superset
```

## 접속

- **URL**: http://localhost:8088

## 최초 1회: DB 초기화 및 관리자 생성

컨테이너가 처음 뜬 뒤, 아래를 한 번 실행하세요.

```bash
# DB 마이그레이션 및 초기화
docker compose exec superset superset db upgrade
docker compose exec superset superset init

# 관리자 계정 생성 (원하는 비밀번호로 변경)
docker compose exec superset superset fab create-admin \
  --username admin \
  --firstname Admin \
  --lastname User \
  --email admin@localhost \
  --password admin
```

이후 http://localhost:8088 에서 **admin / admin** 으로 로그인할 수 있습니다.

## 환경 변수 (.env)

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `SUPERSET_DB_PASSWORD` | Superset 전용 PostgreSQL 비밀번호 | superset |
| `SUPERSET_SECRET_KEY` | Flask 시크릿 키 (운영 환경에서는 반드시 변경) | minseo-superset-secret-change-in-production |
