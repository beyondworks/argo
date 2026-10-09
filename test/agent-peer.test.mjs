// 에이전트 프로세스의 로컬 API 직접 호출 차단(src/agent-peer.mjs).
// 재현(PR #916 분리 검수, 2026-10-09 격리 서버): 에이전트 셸이 curl·python으로 루틴 삭제·결재 자가 승인·주인 직접 턴 열기에 성공했다.
// 문자열을 쪼개 조립한 python(`'127.0'+'.0.1'`)은 셸 문자열 판정을 지나간다 — 그래서 주 방어는 명령 문자열이 아니라 프로세스 관계다.
// 커밋 보안 검토(2026-10-09) 반영: 변경 요청은 판정 실패 = 거절(fail-closed), 부모를 끊고 나간 고아·다른 주소(::1·LAN)·표지 env도 판정.
// 이 파일은 실제 프로세스로 잠근다: 이 시험 프로세스가 서버이고, 여기서 띄운 자식·고아가 에이전트 셸 자리다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { networkInterfaces, tmpdir } from 'node:os';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  descendantsOf, normAddr, isLocalAddr, lsofOwner, procAddr, procSocket, netstatOwner, judgePeer, isInstalledAppExe, peerCheckExempt,
  denyAgentPeer, installAgentPeerGuard, AGENT_MARK,
} from '../src/agent-peer.mjs';

test('자손 계산(순수) — 손자까지, 무관한 가지·자기 자신·순환은 제외', () => {
  const pairs = [[10, 1], [11, 10], [12, 11], [20, 1], [21, 20], [13, 10], [10, 10]];
  assert.deepEqual([...descendantsOf(10, pairs)].sort((a, b) => a - b), [11, 12, 13]);
  assert.deepEqual([...descendantsOf(20, pairs)], [21]);
  assert.equal(descendantsOf(99, pairs).size, 0);
});

test('소켓 소유자 대조(순수) — lsof·/proc·netstat 모두 요청자 쪽 4요소가 맞아야 그 pid', () => {
  const peer = { addr: '127.0.0.1', port: 52344, serverAddr: '127.0.0.1', serverPort: 3001 };
  const out = 'p500\nf5\nn127.0.0.1:52344->127.0.0.1:3001\np600\nf7\nn[::1]:52344->[::1]:3001\np700\nf9\nn127.0.0.1:3001->127.0.0.1:52344\n';
  assert.equal(lsofOwner(out, peer), 500);
  assert.equal(lsofOwner(out, { ...peer, addr: '::1', serverAddr: '::1' }), 600, 'IPv6 대괄호');
  assert.equal(lsofOwner(out, { ...peer, addr: '::ffff:127.0.0.1', serverAddr: '::ffff:127.0.0.1' }), 500, 'IPv4 매핑 표기');
  assert.equal(lsofOwner(out, { ...peer, serverPort: 3011 }), 0, '다른 서버 포트');
  assert.equal(lsofOwner('p700\nf9\nn127.0.0.1:3001->127.0.0.1:52344\n', peer), 0, '서버 쪽 소켓(방향 반대)은 요청자가 아니다');
  assert.equal(normAddr('[::FFFF:127.0.0.1]'), '127.0.0.1');
  assert.equal(normAddr('fe80::1%en0'), 'fe80::1');
  assert.deepEqual(procAddr('0100007F:0BB9'), { addr: '127.0.0.1', port: 3001 });
  assert.deepEqual(procAddr('0000000000000000FFFF00000100007F:CC78'), { addr: '127.0.0.1', port: 52344 });
  assert.deepEqual(procAddr('00000000000000000000000001000000:0BB9'), { addr: '::1', port: 3001 });
  const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const table = `${head}   1: 0100007F:CC78 0100007F:0BB9 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0 20 4 30 10 -1\n`
    + `   2: 0100007F:0BB9 0100007F:CC78 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0 20 4 30 10 -1\n`;
  assert.deepEqual(procSocket(table, peer), { inode: '22222', uid: 1000 }, '요청자 쪽 행과 그 소켓의 계정');
  assert.equal(procSocket(table, { ...peer, port: 52345 }), null);
  const ns = '\r\n활성 연결\r\n\r\n  프로토콜  로컬 주소              외부 주소              상태            PID\r\n'
    + '  TCP    127.0.0.1:3001         127.0.0.1:52344        ESTABLISHED     4000\r\n  TCP    127.0.0.1:52344        127.0.0.1:3001         ESTABLISHED     4242\r\n'
    + '  TCP    [::1]:52344            [::1]:3001             ESTABLISHED     5151\r\n';
  assert.equal(netstatOwner(ns, peer), 4242, 'Windows netstat — 한국어 머리글이어도 마지막 칸이 pid');
  assert.equal(netstatOwner(ns, { ...peer, addr: '::1', serverAddr: '::1' }), 5151);
});

test('이 컴퓨터 주소 판정 — 루프백·자기 카드 주소는 판정 대상, 남의 주소는 아니다', () => {
  const ifaces = { en0: [{ address: '192.168.0.7', internal: false }, { address: 'fe80::abcd%en0', internal: false }] };
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.0.7', '::ffff:192.168.0.7', 'fe80::abcd']) assert.equal(isLocalAddr(a, ifaces), true, a);
  for (const a of ['192.168.0.8', '10.0.0.1', 'fdaa::3', '', undefined]) assert.equal(isLocalAddr(a, ifaces), false, String(a));
});

test('판정 규칙 표(순수) — 사람 클라이언트는 통과, 자손·표지·고아 묶음·에이전트 묶음·서버 묶음 이탈은 에이전트', () => {
  // 1=launchd, 50=앱(Tauri, 서버 부모·그룹 우두머리), 100=서버, 101=CLI 러너, 102=bash(그룹 102), 200=WebKit 네트워크(자기 그룹),
  // 300=터미널 zsh, 301=사람 curl(자기 작업 그룹), 60=리눅스 WebKitGTK 네트워크(앱의 자식 — 서버와 같은 그룹)
  const base = [[1, 0, 1], [50, 1, 50], [100, 50, 50], [101, 100, 50], [102, 101, 102], [200, 1, 200], [300, 1, 300], [301, 300, 301], [60, 50, 50]];
  const T = (extra = []) => new Map([...base, ...extra].map(([p, pp, pg]) => [p, { ppid: pp, pgid: pg }]));
  const j = (pid, table = T(), marked) => judgePeer({ self: 100, pid, table, marked });
  assert.deepEqual(j(100), { agent: false, reason: 'self' });
  assert.deepEqual(j(200), { agent: false, reason: 'human' }, '웹뷰 네트워크 프로세스');
  assert.deepEqual(j(301), { agent: false, reason: 'human' }, '터미널 curl');
  assert.deepEqual(j(60), { agent: false, reason: 'human' }, '리눅스 WebKitGTK — 서버와 같은 그룹이어도 앱 밑');
  assert.equal(j(102).reason, 'descendant');
  assert.equal(j(400, T([[400, 1, 400]]), new Set([400])).reason, 'marked', '표지 env가 보이는 고아(python 등)');
  assert.equal(j(401, T([[401, 1, 999]])).reason, 'orphan-group', '우두머리(끝난 bash)를 잃은 고아 curl');
  assert.equal(j(402, T([[402, 1, 102]])).reason, 'agent-group', '살아 있는 에이전트 bash 그룹의 고아');
  assert.equal(j(403, T([[403, 1, 50]])).reason, 'server-group', '서버와 같은 그룹인데 앱 밑이 아닌 고아');
  assert.equal(j(404, T([[404, 1, 404]])).reason, 'human', '그룹을 새로 만들고 표지도 지운 고아 — 프로세스로 가릴 수 없다(문서화된 한계)');
  assert.throws(() => j(999), { code: 'PEER_GONE' }, '표에 없는 상대 = 판정 불가');
  // ⑥ macOS 표(exe 있음): 고아인데 설치된 앱 묶음 밖이면 에이전트, 앱 묶음 안(브라우저·웹뷰)이면 사람
  const H = '/Users/u';
  const mac = (pid, exe, extra = []) => judgePeer({ self: 100, pid, table: new Map([...base.map(([p, pp, pg]) => [p, { ppid: pp, pgid: pg, exe: '/x' }]), ...extra]), home: H });
  assert.equal(mac(500, '', [[500, { ppid: 1, pgid: 500, exe: '/usr/bin/curl' }]]).reason, 'orphan-cli', '세션 분리 + 시스템 curl(env 안 보임)');
  assert.equal(mac(501, '', [[501, { ppid: 1, pgid: 501, exe: '/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python' }]]).reason, 'orphan-cli', '설치 위치 밖의 .app(파이썬 프레임워크)');
  assert.equal(mac(502, '', [[502, { ppid: 1, pgid: 502, exe: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking' }]]).reason, 'human', 'WebKit 네트워크(데스크톱 앱 웹뷰·사파리)');
  assert.equal(mac(503, '', [[503, { ppid: 1, pgid: 503, exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }]]).reason, 'human', '브라우저');
  assert.equal(mac(504, '', [[504, { ppid: 1, pgid: 504, exe: `${H}/Applications/Arc.app/Contents/MacOS/Arc` }]]).reason, 'human', '사용자 Applications');
  assert.equal(mac(301).reason, 'human', '터미널 명령은 고아가 아니다');
  assert.equal(isInstalledAppExe('/Applications/x', H), false, '앱 묶음이 아닌 /Applications 파일');
});

test('판정 제외 — 신원 마커와 정적 자산만', () => {
  assert.equal(peerCheckExempt('/api/ping'), true);
  assert.equal(peerCheckExempt('/_next/static/chunks/a.js'), true);
  for (const u of ['/api/companies/w/approvals', '/api/companies/w/routines?id=r', '/api/companies/w/chat', '/api/device/login', '/auth/signout', '/c/w']) assert.equal(peerCheckExempt(u), false, u);
});

// ── fail-closed: 판정 실패 시 변경은 거절, 읽기는 통과 ──
const fakeReq = (method, addr = '127.0.0.1') => ({ method, url: '/api/companies/w/approvals', headers: {}, socket: { remoteAddress: addr, remotePort: 51000 + Math.floor(Math.random() * 1000), localAddress: '127.0.0.1', localPort: 3001 }, resume() {} });
const fakeRes = () => { const r = { status: 0, body: '', headersSent: false }; r.writeHead = (s) => { r.status = s; }; r.end = (b) => { r.body = String(b); }; return r; };
const boom = async () => { throw Object.assign(new Error('lsof timed out'), { code: 'ETIMEDOUT' }); };

test('fail-closed — 변경 요청의 판정이 실패(도구 오류·시간 초과·소유자 없음·소켓 정보 없음)하면 403 agent_check_failed', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = fakeRes();
    assert.equal(await denyAgentPeer(fakeReq(method), res, { classify: boom }), true, method);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).errorCode, 'agent_check_failed');
  }
  const gone = fakeRes();
  await denyAgentPeer(fakeReq('POST'), gone, { classify: async () => { throw Object.assign(new Error('x'), { code: 'PEER_UNKNOWN' }); } });
  assert.equal(JSON.parse(gone.body).errorCode, 'agent_check_failed', '소켓 소유자를 못 찾음');
  const noSock = fakeRes();
  assert.equal(await denyAgentPeer({ method: 'POST', url: '/api/x', headers: {}, socket: {}, resume() {} }, noSock), true, '소켓 정보 없음');
  assert.equal(JSON.parse(noSock.body).errorCode, 'agent_check_failed');
});

test('fail-closed 범위 — 읽기는 판정 실패여도 통과, 원격(이 컴퓨터 밖) 주소는 판정하지 않는다, 사람 판정은 통과', async () => {
  assert.equal(await denyAgentPeer(fakeReq('GET'), fakeRes(), { descendant: boom }), false, '읽기');
  assert.equal(await denyAgentPeer(fakeReq('POST', '203.0.113.9'), fakeRes(), { classify: boom }), false, '원격 사용자(클라우드·프록시 뒤)');
  assert.equal(await denyAgentPeer(fakeReq('POST'), fakeRes(), { classify: async () => ({ agent: false, reason: 'human', pid: 9 }) }), false);
  const res = fakeRes();
  assert.equal(await denyAgentPeer(fakeReq('POST'), res, { classify: async () => ({ agent: true, reason: 'orphan-group', pid: 9 }) }), true);
  assert.equal(JSON.parse(res.body).errorCode, 'agent_loopback');
});

// ── 실제 프로세스: 이 시험 프로세스 = 서버, 여기서 띄운 자식·고아 = 에이전트 셸 ──
const onWin = process.platform === 'win32';
const reached = [];
installAgentPeerGuard();
installAgentPeerGuard(); // 멱등 — 두 번 감싸지 않는다
const handler = (req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    reached.push(`${req.method} ${req.url} ${b}`);
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  });
};
const listen = (host) => new Promise((resolve, reject) => { const s = http.createServer(handler); s.once('error', reject); s.listen(0, host, () => resolve(s)); });
const srv = await listen('127.0.0.1');
after(() => srv.close());
const PORT = srv.address().port;
const sh = (cmd, args, opts = {}) => new Promise((resolve) => execFile(cmd, args, { timeout: 15_000, ...opts }, (err, stdout) => resolve({ err, out: String(stdout) })));
// 자식 node — 문자열을 쪼갠 주소로 부른다(셸 문자열 판정을 지나가는 모양, 재현의 python과 같은 계열)
const childFetch = (path, method, { host = "['127','0','0','1'].join('.')", port = PORT } = {}) => sh(process.execPath, ['-e', `fetch('http://'+${host}+':'+${port}+'${path}',{method:'${method}',headers:{cookie:'argo-device=1','content-type':'application/json'},body:${method === 'GET' ? 'undefined' : '\'{"id":"r1","approve":true}\''}}).then(async r=>console.log(r.status, await r.text()))`]);

test('표지 env — 서버 프로세스에 심고, 자식이 물려받는다', async () => {
  assert.equal(process.env[AGENT_MARK], String(process.pid));
  const { out } = await sh(process.execPath, ['-e', `console.log(process.env.${AGENT_MARK})`]);
  assert.equal(out.trim(), String(process.pid));
});

test('자손(에이전트 셸 자리)의 요청은 403 agent_loopback — 핸들러에 닿지 않는다: 루틴 삭제·결재 승인·대화 시작·루틴 수정·읽기', async () => {
  reached.length = 0;
  for (const [path, method] of [['/api/companies/w/routines?id=r1', 'DELETE'], ['/api/companies/w/approvals', 'POST'], ['/api/companies/w/chat', 'POST'], ['/api/companies/w/routines', 'PUT'], ...(onWin ? [] : [['/api/companies/w/approvals', 'GET']])]) {
    const { out } = await childFetch(path, method);
    assert.match(out, /^403 /, `${method} ${path}: ${out}`);
    assert.match(out, /"errorCode":"agent_loopback"/);
  }
  assert.deepEqual(reached, [], '거절된 요청은 핸들러에 닿지 않았다');
});

const hasCurl = !onWin && !(await sh('curl', ['--version'])).err;
const hasPy = !onWin && !(await sh('python3', ['--version'])).err;
test('자손 curl(재현과 같은 명령 모양)도 403', { skip: !hasCurl }, async () => {
  reached.length = 0;
  const del = await sh('curl', ['-s', '-w', ' %{http_code}', '-X', 'DELETE', '-H', 'Cookie: argo-device=1', `http://127.0.0.1:${PORT}/api/companies/w/routines?id=r1`]);
  assert.match(del.out, /agent_loopback.* 403$/, del.out);
  assert.deepEqual(reached, []);
});

// 부모를 끊고 나간 고아 — 결과를 파일로 받는다(부모 셸은 먼저 끝난다)
const orphanRun = async (inner, tag) => {
  const out = join(tmpdir(), `argo-agent-peer-${process.pid}-${tag}.txt`);
  await rm(out, { force: true });
  await sh('/bin/sh', ['-c', `( ${inner} > '${out}' 2>&1 & ) ; exit 0`]);
  for (let i = 0; i < 100; i++) { const t = await readFile(out, 'utf8').catch(() => ''); if (/\d{3}/.test(t)) { await rm(out, { force: true }); return t; } await new Promise((r) => setTimeout(r, 100)); }
  return 'timeout';
};
test('고아(부모가 먼저 끝난 curl — 맥에서는 시스템 실행 파일이라 env도 안 보인다)의 변경도 403 — 그룹 판정', { skip: !hasCurl }, async () => {
  reached.length = 0;
  const t = await orphanRun(`curl -s -w ' %{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"a1","approve":true}' http://127.0.0.1:${PORT}/api/companies/w/approvals`, 'orphan-curl');
  assert.match(t, /agent_loopback.* 403$/, t);
  assert.deepEqual(reached, []);
});
test('세션을 새로 만든 고아 python(setsid)도 표지 env로 403', { skip: !hasPy }, async () => {
  reached.length = 0;
  const py = `import os,urllib.request as u\nos.setsid()\nr=u.Request('http://127.0.0.1:${PORT}/api/companies/w/chat',data=b'{}',method='POST')\ntry: print(u.urlopen(r).status)\nexcept Exception as e: print(e.code, e.read().decode())`;
  const t = await orphanRun(`python3 -c "${py.replace(/"/g, '\\"')}"`, 'orphan-py');
  assert.match(t, /^403 .*agent_loopback/, t);
  assert.deepEqual(reached, []);
});

const hasPerl = !onWin && !(await sh('perl', ['-v'])).err;
test('세션을 새로 만들고 시스템 curl로 바꾼 고아(perl setsid → exec curl)도 변경은 403', { skip: !hasPerl || !hasCurl }, async () => {
  reached.length = 0;
  const out = join(tmpdir(), `argo-agent-peer-${process.pid}-setsid.txt`);
  await rm(out, { force: true });
  const perl = `use POSIX; if (fork() == 0) { POSIX::setsid(); select(undef,undef,undef,0.7); open(STDOUT, '>', '${out}'); exec('curl', '-s', '-w', ' %{http_code}', '-X', 'DELETE', 'http://127.0.0.1:${PORT}/api/companies/w/routines?id=r1'); } exit 0;`;
  await sh('perl', ['-e', perl]);
  let t = '';
  for (let i = 0; i < 60 && !/\d{3}$/.test(t); i++) { await new Promise((r) => setTimeout(r, 100)); t = await readFile(out, 'utf8').catch(() => ''); }
  await rm(out, { force: true });
  assert.match(t, /agent_loopback.* 403$/, t);
  assert.deepEqual(reached, []);
});

test('다른 주소 — IPv6 루프백 [::1]로 붙어도 403', { skip: onWin }, async (t) => {
  const v6 = await listen('::1').catch(() => null);
  if (!v6) return t.skip('이 컴퓨터에 ::1 없음');
  try {
    reached.length = 0;
    const { out } = await childFetch('/api/companies/w/approvals', 'POST', { host: "'['+'::1'+']'", port: v6.address().port });
    assert.match(out, /^403 .*agent_loopback/, out);
    assert.deepEqual(reached, []);
  } finally { v6.close(); }
});

const lan = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')?.address;
test('다른 주소 — 서버가 0.0.0.0이면 이 컴퓨터의 LAN 주소로 붙어도 403', { skip: !lan || onWin }, async () => {
  const any = await listen('0.0.0.0');
  try {
    reached.length = 0;
    const { out } = await childFetch('/api/companies/w/routines?id=r1', 'DELETE', { host: `'${lan}'`, port: any.address().port });
    assert.match(out, /^403 .*agent_loopback/, out);
    assert.deepEqual(reached, []);
  } finally { any.close(); }
});

test('자손도 /api/ping(신원 마커)은 통과', async () => {
  reached.length = 0;
  const { out } = await childFetch('/api/ping', 'GET');
  assert.match(out, /^200 /, out);
  assert.equal(reached.length, 1);
});

test('에이전트가 아닌 상대(여기서는 서버 프로세스 자신)는 변경도 통과, 본문도 온전히 전달 — 자손이 살아 있는 동안에도', async () => {
  reached.length = 0;
  const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']); // 자손이 있어야 프로세스 표 대조까지 실제로 돈다
  after(() => alive.kill());
  await new Promise((r) => setTimeout(r, 300));
  const r = await fetch(`http://127.0.0.1:${PORT}/api/companies/w/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"a1","approve":true}' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(reached, ['POST /api/companies/w/approvals {"id":"a1","approve":true}']);
  const g = await fetch(`http://127.0.0.1:${PORT}/api/companies/w/approvals`);
  assert.equal(g.status, 200);
  alive.kill();
});
