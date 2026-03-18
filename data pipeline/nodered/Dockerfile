# Node-RED with OPC UA + MQTT for FDC (PLC → OPC UA → Node-RED → MQTT)
FROM nodered/node-red:latest-20-minimal

USER root
RUN apk add --no-cache python3 make g++ su-exec

COPY package.json /opt/node-red/package.json
RUN mkdir -p /data && cp /opt/node-red/package.json /data/ && chown -R node-red:node-red /data && cd /data && npm install --production && apk del make g++

USER node-red
ENV NODE_RED_ENABLE_SAFE_MODE=false
EXPOSE 1880

# flow 파일 고정용 설정 (entrypoint에서 /data로 복사)
COPY settings-docker.js /opt/node-red/settings-docker.js

# entrypoint: root로 /data 소유권 수정 후 node-red로 전환 (바인드 마운트 권한 해결)
COPY entrypoint.sh /entrypoint.sh
USER root
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node-red"]
