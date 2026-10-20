// qbwr 도구 시험용 미리 읽기(node --import) — 자식 프로세스의 네트워크를 가로채 실제로 나가지 않게 한다.
// 검문이 깨져도 시험이 qbwr·운영에 요청을 보내지 않도록(#1093 재검수: 변이 실행 중 qbwr로 거부된 요청 8건이 실제로 나갔다).
// 막는 길: fetch·WebSocket(전역), node:http·https의 request·get, node:net·tls의 connect·createConnection, net.Socket#connect(나머지 길의 바닥).
// 가로챈 요청은 QBWR_NET_LOG 파일에 "<길> <주소>" 한 줄씩 남기고 실패시킨다. 127.0.0.1(시험 수신기)도 막는다.
// 자기 확인은 test/qbwr-tools.test.mjs의 카나리 칸이 한다(이 파일이나 NODE_OPTIONS가 빠지면 그 칸이 실패한다).
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const log = (line) => { if (process.env.QBWR_NET_LOG) appendFileSync(process.env.QBWR_NET_LOG, `${line}\n`); };
const target = (a) => {
  const x = a[0];
  if (typeof x === 'string' || x instanceof URL) return String(x);
  if (typeof x === 'number') return `${a[1] ?? 'localhost'}:${x}`;
  if (x && typeof x === 'object') return x.href ?? `${x.protocol ?? ''}${x.host ?? x.hostname ?? 'localhost'}:${x.port ?? ''}${x.path ?? ''}`;
  return '?';
};
const deny = (kind) => (...a) => { log(`${kind} ${target(a)}`); throw new Error(`${kind} 차단(qbwr 시험: 네트워크 차단)`); };

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  log(`fetch ${url}`);
  throw new TypeError('fetch failed (qbwr 시험: 네트워크 차단)');
};
globalThis.WebSocket = class {
  constructor(url) { log(`ws ${url}`); throw new Error('WebSocket 차단(qbwr 시험)'); }
};
http.request = deny('http'); http.get = deny('http');
https.request = deny('https'); https.get = deny('https');
net.connect = deny('net'); net.createConnection = deny('net');
tls.connect = deny('tls');
net.Socket.prototype.connect = function (...a) { return deny('net')(...a); };
syncBuiltinESMExports(); // import { request } from 'node:http'처럼 이름으로 가져와도 바뀐 함수를 보게
