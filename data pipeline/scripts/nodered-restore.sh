#!/bin/sh
# 프로젝트 nodered_data 폴더 → Node-RED 볼륨(minseo_nodered_data)으로 복사
# 다른 PC에서 clone/pull 한 뒤 이 스크립트 실행 후 docker compose up 하면 동일 플로우 적용
set -e
cd "$(dirname "$0")/.."
echo "Restore: nodered_data/ -> volume"
docker run --rm \
  -v minseo_nodered_data:/to \
  -v "$(pwd)/nodered_data:/from" \
  alpine sh -c "cp -a /from/flows.json /to/flows.json; cp -a /from/package.json /to/package.json 2>/dev/null || true; cp -a /from/package-lock.json /to/package-lock.json 2>/dev/null || true"
echo "Done. Run: docker compose up -d nodered"