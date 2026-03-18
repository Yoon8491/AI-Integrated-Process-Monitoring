# Node-RED 저장 (named volume)

Node-RED 데이터는 **Docker named volume** `minseo_nodered_data`에 저장됩니다.

- **도커를 껐다 켜도** 같은 PC에서는 항상 같은 데이터가 유지됩니다.
- **실행 경로**에 상관없이 동일한 볼륨을 사용합니다.

## 다른 PC와 플로우 공유

1. **백업 (볼륨 → repo)**  
   Node-RED에서 Deploy 한 뒤, 주기적으로:
   ```bash
   cd minseo
   sh scripts/nodered-backup.sh
   git add nodered_data/flows.json
   git commit -m "chore: Node-RED flows backup"
   git push
   ```

2. **다른 PC에서 복원 (repo → 볼륨)**  
   clone/pull 한 뒤:
   ```bash
   cd minseo
   sh scripts/nodered-restore.sh
   docker compose up -d nodered
   ```

## named volume으로 바꾼 뒤 처음 한 번

기존 `nodered_data/` 폴더의 플로우를 볼륨에 넣으려면:

```bash
cd minseo
sh scripts/nodered-restore.sh
docker compose up -d nodered
```

이후에는 Node-RED에서 작업 후 **배포(Deploy)** 하면 볼륨에 저장됩니다.
