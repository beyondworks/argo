// 에이전트 프로세스의 로컬 API 직접 호출 차단(src/agent-peer.mjs) — 연결 상대가 이 서버의 자손이면 403.
// 재현(PR #916 분리 검수, 2026-10-09 격리 서버): 에이전트 셸이 curl·python으로 루틴 삭제·결재 자가 승인·주인 직접 턴 열기에 성공했다.
// 문자열을 쪼개 조립한 python(`'127.0'+'.0.1'`)은 셸 문자열 판정을 지나간다 — 그래서 주 방어는 명령 문자열이 아니라 프로세스 관계다.
// 이 파일은 실제 프로세스로 잠근다: 이 시험 프로세스가 서버이고, 여기서 띄운 자식(curl·node)이 에이전트 셸 자리다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import {
  descendantsOf, normAddr, lsofOwner, procAddr, procInode, peerCheckExempt, installAgentPeerGuard,
} from '../src/agent-peer.mjs';

test('자손 계산(순수) — 손자까지, 무관한 가지·자기 자신·순환은 제외', () => {
  const pairs = [[10, 1], [11, 10], [12, 11], [20, 1], [21, 20], [13, 10], [10, 10]];
  assert.deepEqual(descendantsOf(10, pairs).sort((a, b) => a - b), [11, 12, 13]);
  assert.deepEqual(descendantsOf(20, pairs), [21]);
  assert.deepEqual(descendantsOf(99, pairs), []);
});

test('lsof 출력 대조(순수) — 상대 쪽 소켓(local = 요청자, remote = 서버) 4요소가 모두 맞아야 그 pid', () => {
  const out = 'p500\nf5\nn127.0.0.1:52344->127.0.0.1:3001\np600\nf7\nn[::1]:52344->[::1]:3001\n';
  assert.equal(lsofOwner(out, { addr: '127.0.0.1', port: 52344, serverAddr: '127.0.0.1', serverPort: 3001 }), 500);
  assert.equal(lsofOwner(out, { addr: '::1', port: 52344, serverAddr: '::1', serverPort: 3001 }), 600, 'IPv6 대괄호');
  assert.equal(lsofOwner(out, { addr: '::ffff:127.0.0.1', port: 52344, serverAddr: '::ffff:127.0.0.1', serverPort: 3001 }), 500, 'IPv4 매핑 표기');
  assert.equal(lsofOwner(out, { addr: '127.0.0.1', port: 52344, serverAddr: '127.0.0.1', serverPort: 3011 }), 0, '다른 서버 포트');
  assert.equal(lsofOwner('p700\nf5\nn127.0.0.1:3001->127.0.0.1:52344\n', { addr: '127.0.0.1', port: 52344, serverAddr: '127.0.0.1', serverPort: 3001 }), 0, '서버 쪽 소켓(방향 반대)은 요청자가 아니다');
  assert.equal(normAddr('[::FFFF:127.0.0.1]'), '127.0.0.1');
});

test('/proc/net/tcp 대조(순수, 리눅스 경로) — 리틀 엔디언 주소·IPv4 매핑 IPv6·::1', () => {
  assert.deepEqual(procAddr('0100007F:0BB9'), { addr: '127.0.0.1', port: 3001 });
  assert.deepEqual(procAddr('0000000000000000FFFF00000100007F:CC78'), { addr: '127.0.0.1', port: 52344 });
  assert.deepEqual(procAddr('00000000000000000000000001000000:0BB9'), { addr: '::1', port: 3001 });
  const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const table = `${head}   0: 0100007F:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0 100 0 0 10 0\n`
    + `   1: 0100007F:CC78 0100007F:0BB9 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0 20 4 30 10 -1\n`
    + `   2: 0100007F:0BB9 0100007F:CC78 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0 20 4 30 10 -1\n`;
  assert.equal(procInode(table, { addr: '127.0.0.1', port: 52344, serverAddr: '127.0.0.1', serverPort: 3001 }), '22222', '요청자 쪽 행');
  assert.equal(procInode(table, { addr: '127.0.0.1', port: 52345, serverAddr: '127.0.0.1', serverPort: 3001 }), null);
});

test('판정 제외 — 신원 마커와 정적 자산만', () => {
  assert.equal(peerCheckExempt('/api/ping'), true);
  assert.equal(peerCheckExempt('/api/ping?x=1'), true);
  assert.equal(peerCheckExempt('/_next/static/chunks/a.js'), true);
  for (const u of ['/api/companies/w/approvals', '/api/companies/w/routines?id=r', '/api/companies/w/chat', '/api/device/login', '/auth/signout', '/c/w']) assert.equal(peerCheckExempt(u), false, u);
});

// ── 실제 프로세스: 이 시험 프로세스 = 서버, 여기서 띄운 자식 = 에이전트 셸 ──
const onWin = process.platform === 'win32'; // Windows는 판정하지 않는다(모듈 머리말 — 권한 게이트의 셸 판정만)
const reached = [];
installAgentPeerGuard();
installAgentPeerGuard(); // 멱등 — 두 번 감싸지 않는다
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    reached.push(`${req.method} ${req.url} ${b}`);
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => srv.close());
const PORT = srv.address().port;
const sh = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15_000 }, (err, stdout) => resolve({ err, out: String(stdout) })));
// 자식 node — 문자열을 쪼갠 주소로 부른다(셸 문자열 판정을 지나가는 모양, 재현의 python과 같은 계열)
const childFetch = (path, method) => sh(process.execPath, ['-e', `fetch('http://'+['127','0','0','1'].join('.')+':'+${PORT}+'${path}',{method:'${method}',headers:{cookie:'argo-device=1','content-type':'application/json'},body:${method === 'GET' ? 'undefined' : '\'{"id":"r1","approve":true}\''}}).then(async r=>console.log(r.status, await r.text()))`]);

test('자손(에이전트 셸 자리)의 요청은 403 agent_loopback — 핸들러에 닿지 않는다: 루틴 삭제·결재 승인·대화 시작', { skip: onWin }, async () => {
  reached.length = 0;
  for (const [path, method] of [['/api/companies/w/routines?id=r1', 'DELETE'], ['/api/companies/w/approvals', 'POST'], ['/api/companies/w/chat', 'POST'], ['/api/companies/w/routines', 'PUT']]) {
    const { out } = await childFetch(path, method);
    assert.match(out, /^403 /, `${method} ${path}: ${out}`);
    assert.match(out, /"errorCode":"agent_loopback"/);
  }
  assert.deepEqual(reached, [], '거절된 요청은 핸들러에 닿지 않았다');
});

const hasCurl = !onWin && !(await sh('curl', ['--version'])).err;
test('자손 curl(재현과 같은 명령 모양)도 403 — 읽기(GET)도 막는다', { skip: onWin || !hasCurl }, async () => {
  reached.length = 0;
  const del = await sh('curl', ['-s', '-w', ' %{http_code}', '-X', 'DELETE', '-H', 'Cookie: argo-device=1', `http://127.0.0.1:${PORT}/api/companies/w/routines?id=r1`]);
  assert.match(del.out, /agent_loopback.* 403$/, del.out);
  const get = await sh('curl', ['-s', '-w', ' %{http_code}', `http://localhost:${PORT}/api/companies/w/approvals`]);
  assert.match(get.out, / 403$/, get.out);
  assert.deepEqual(reached, []);
});

test('자손도 /api/ping(신원 마커)은 통과', { skip: onWin }, async () => {
  reached.length = 0;
  const { out } = await childFetch('/api/ping', 'GET');
  assert.match(out, /^200 /, out);
  assert.equal(reached.length, 1);
});

test('자손이 아닌 상대(사람 자리 — 여기서는 서버 프로세스 자신)는 그대로 통과, 본문도 온전히 전달 — 에이전트 자손이 살아 있는 동안에도', async () => {
  reached.length = 0;
  const { spawn } = await import('node:child_process');
  const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']); // 자손이 있어야 프로세스 표 대조까지 실제로 돈다
  after(() => alive.kill());
  await new Promise((r) => setTimeout(r, 300));
  const r = await fetch(`http://127.0.0.1:${PORT}/api/companies/w/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"a1","approve":true}' });
  assert.equal(r.status, 200);
  assert.deepEqual(reached, ['POST /api/companies/w/approvals {"id":"a1","approve":true}']);
  alive.kill();
});
