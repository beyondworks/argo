// 회사 서버 연결 안내 — 연결 명령 앞에 한 줄로 이어 붙이는 환경변수 접두(세 줄로 따로 붙이면 명령에 전달되지 않는다).
// 값 자리는 자리표시자. 명령 자체(ARGO_NODE_CODE=… node scripts/msgr-node-bootstrap.mjs)는 화면에서 따로 만든다.
export const NODE_ENV_PREFIX = 'ARGO_NODE_EMAIL=<email> ARGO_NODE_PASSWORD=<password> ARGO_ROOT=<folder>';
