#!/bin/sh
# Node-RED 볼륨(minseo_nodered_data) → 프로젝트 nodered_data 폴더로 복사
# Git 커밋 후 다른 PC에서 pull 하면 동일 플로우 사용 가능
set -e
cd "$(dirname "$0")/.."
echo "Backup: volume -> nodered_data/"
docker run --rm \
  -v minseo_nodered_data:/from \
  -v "$(pwd)/nodered_data:/to" \
  alpine sh -c "cp -a /from/flows.json /to/flows.json 2>/dev/null || true; cp -a /from/package.json /to/package.json 2>/dev/null || true; cp -a /from/package-lock.json /to/package-lock.json 2>/dev/null || true"
echo "Done. Commit with: git add nodered_data/flows.json && git commit -m 'chore: Node-RED flows backup'"
