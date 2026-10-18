// qbwr 도구 시험용 미리 읽기(node --import) — 자식 프로세스의 fetch·WebSocket을 가로채 실제 네트워크로 나가지 않게 한다.
// 검문이 깨져도 시험이 qbwr·운영에 요청을 보내지 않도록(#1093 재검수: 변이 실행 중 qbwr로 거부된 요청 8건이 실제로 나갔다).
// 가로챈 요청은 QBWR_NET_LOG 파일에 "fetch <주소>" 한 줄씩 남기고, 네트워크 오류처럼 실패시킨다. 127.0.0.1(시험 수신기)도 막는다.
import { appendFileSync } from 'node:fs';

const log = (line) => { if (process.env.QBWR_NET_LOG) appendFileSync(process.env.QBWR_NET_LOG, `${line}\n`); };
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  log(`fetch ${url}`);
  throw new TypeError('fetch failed (qbwr 시험: 네트워크 차단)');
};
globalThis.WebSocket = class {
  constructor(url) { log(`ws ${url}`); throw new Error('WebSocket 차단(qbwr 시험)'); }
};
