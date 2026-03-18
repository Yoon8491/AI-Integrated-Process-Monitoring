# OPC UA Docker + UAExpert 접속 가이드

## 1. OPC UA 서버 (Docker)

프로젝트의 `docker-compose.yml`에 Microsoft OPC PLC 시뮬레이터가 포함되어 있습니다.

### 기동

```bash
docker compose up -d opcua
```

### 연결 정보

| 항목 | 값 |
|------|-----|
| **Endpoint** | `opc.tcp://<호스트>:50000` |
| **로컬** | `opc.tcp://localhost:50000` |
| **포트** | 50000 (OPC UA), 8080 (웹) |

---

## 2. UAExpert (Linux) 설치

### 다운로드

1. [Unified Automation - OPC UA Clients](https://www.unified-automation.com/downloads/opc-ua-clients.html) 접속
2. **UaExpert** Linux용 AppImage 다운로드

### 설치 및 실행

```bash
# 실행 권한 부여
chmod +x UaExpert*.AppImage

# 실행
./UaExpert*.AppImage
```

- root 권한 불필요
- 삭제는 AppImage 파일만 제거하면 됨
- 첫 실행 시 애플리케이션 인증서 생성 요청이 나오면 생성 진행

---

## 3. UAExpert에서 OPC UA 서버 접속

1. UAExpert 실행
2. **Server** → **Add** (또는 Ctrl+N)
3. **Custom Discovery** 탭에서:
   - **URL**: `opc.tcp://localhost:50000` (같은 머신)
   - 또는 `opc.tcp://<서버IP>:50000` (원격)
4. **OK** → 서버 더블클릭으로 연결

### 접속 확인

- 연결 성공 시 Address Space에 노드 트리가 보임
- `Root` → `Objects` → `OpcPlc` 아래 시뮬레이션 데이터 확인 가능

---

## 4. 트러블슈팅

### 연결 실패 시

- Docker 컨테이너 실행 여부 확인: `docker ps | grep opcua`
- 방화벽에서 50000 포트 허용 여부 확인
- 원격 접속 시: `opc.tcp://<실제서버IP>:50000` 사용

### 보안 모드

- 기본적으로 None(보안 없음) 또는 Anonymous로 접속 가능
- 인증서 오류 시 UAExpert에서 **Security** → **None** 선택 후 재시도
