// Node-RED Docker: flow 파일 이름을 항상 flows.json으로 고정
// (기본값 flows_<hostname>.json 이면 컨테이너 재시작 시 hostname이 바뀌어 플로우가 비어 보이는 문제 방지)
module.exports = {
    flowFile: 'flows.json',
    flowFilePretty: true
};
