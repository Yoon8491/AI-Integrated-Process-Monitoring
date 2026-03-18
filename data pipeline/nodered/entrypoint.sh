#!/bin/sh
set -e
# 바인드 마운트된 /data를 node-red 소유로 (Mac 등 호스트 권한 이슈 해결)
chown -R node-red:node-red /data 2>/dev/null || true

# flow 파일 이름을 항상 flows.json으로 고정 (hostname 바뀌어도 저장 유지)
if [ -f /opt/node-red/settings-docker.js ]; then
  cp /opt/node-red/settings-docker.js /data/settings.js
  chown node-red:node-red /data/settings.js
fi

if [ ! -f /data/package.json ] && [ -f /opt/node-red/package.json ]; then
  cp /opt/node-red/package.json /data/
  chown node-red:node-red /data/package.json
fi
if [ -f /data/package.json ] && [ ! -d /data/node_modules/node-red-contrib-opcua ]; then
  echo "Installing Node-RED nodes from /data/package.json..."
  cd /data && su-exec node-red npm install --production --no-audit --no-fund
fi
exec su-exec node-red "$@"
