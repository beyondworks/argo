// 권한 게이트 2차 방어 — 셸 명령이 이 컴퓨터의 Argo API(루프백)를 부르면 실행 전에 거절한다(src/loopback-api.mjs).
// 재현(PR #916 분리 검수, 2026-10-09 격리 서버): 에이전트 Bash의 `curl -X DELETE -H 'Cookie: argo-device=1' http://127.0.0.1:<포트>/api/companies/<ws>/routines?id=…`가
// 게이트 허용 → 루틴 삭제. 주 방어는 서버의 연결 상대 판정(test/agent-peer.test.mjs)이고, 이 시험은 앞단 판정과 게이트 배선을 잠근다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-loopback-api-'));
const { loopbackPortCandidates, shellCallsArgoApi, probeArgoPort } = await import('../src/loopback-api.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');

const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const argoPing = await listen((req, res) => { res.setHeader('content-type', 'application/json'); res.end(req.url === '/api/ping' ? '{"argo":true,"version":"0.0.0"}' : '{}'); });
const otherApp = await listen((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }); // 사용자의 다른 개발 서버
after(() => { argoPing.close(); otherApp.close(); });
const ARGO = argoPing.address().port; const OTHER = otherApp.address().port;

test('포트 후보 — 루프백 호스트가 있을 때만, URL·nc·python 튜플 표기 모두', () => {
  assert.deepEqual(loopbackPortCandidates("curl -X DELETE 'http://127.0.0.1:3001/api/companies/w/routines?id=r1'"), [3001]);
  assert.deepEqual(loopbackPortCandidates('wget -qO- http://localhost:3011/api/x'), [3011]);
  assert.deepEqual(loopbackPortCandidates('curl http://[::1]:3021/api/x'), [3021]);
  assert.deepEqual(loopbackPortCandidates('curl http://0.0.0.0:3001/'), [3001]);
  assert.deepEqual(loopbackPortCandidates('curl http://127.1:3001/'), [3001], '127.1 축약');
  assert.deepEqual(loopbackPortCandidates('curl http://0x7f000001:3001/'), [3001], '16진 표기');
  assert.deepEqual(loopbackPortCandidates('curl http://2130706433:3001/'), [3001], '10진 표기');
  assert.deepEqual(loopbackPortCandidates('printf x | nc 127.0.0.1 3001'), [3001], 'nc는 호스트와 포트가 떨어져 있다');
  assert.deepEqual(loopbackPortCandidates("python3 -c \"import http.client as h; c=h.HTTPConnection('localhost', 3001)\""), [3001]);
  assert.deepEqual(loopbackPortCandidates('curl https://example.com:3001/'), [], '루프백이 아니면 후보 없음');
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')?.address;
  if (lan) assert.deepEqual(loopbackPortCandidates(`curl -X DELETE http://${lan}:3001/api/x`), [3001], '이 컴퓨터의 LAN 주소(서버가 0.0.0.0일 때)');
  assert.deepEqual(loopbackPortCandidates('curl http://10.255.255.254:3001/'), [], '이 컴퓨터가 아닌 사설 주소');
  assert.deepEqual(loopbackPortCandidates('ls -la'), []);
  assert.deepEqual(loopbackPortCandidates('echo x127.0.0.1y'), [], '단어 중간은 호스트가 아니다');
});

test('판정 — 루프백 Argo 주소·포트가 보이면 거절이 기본, 아주 좁은 "언급"만 통과(막는 쪽)', async () => {
  const noProbe = async () => { throw new Error('탐침하면 안 된다'); };
  const own = { ownPort: 3477, probe: noProbe };
  const P = 3477;
  assert.equal(await shellCallsArgoApi('curl -X POST http://127.0.0.1:3477/api/companies/w/approvals', own), true);
  assert.equal(await shellCallsArgoApi('curl https://example.com/', own), false, '루프백 없으면 탐침도 없다');
  assert.equal(await shellCallsArgoApi(`curl -X DELETE http://localhost:${ARGO}/api/companies/w/routines?id=r`, { ownPort: 0 }), true, '다른 Argo(상주·앱)도 막는다');
  assert.equal(await shellCallsArgoApi(`curl http://127.0.0.1:${OTHER}/api/items`, { ownPort: 0 }), false, '사용자의 다른 로컬 서버는 그대로');
  assert.equal(await probeArgoPort(OTHER), false);
  assert.equal(await probeArgoPort(ARGO), true);
  // 아주 좁은 '언급'만 통과 — grep·rg·echo·printf·cat·head·tail·wc·sort·less 뿐이고 위험 구조·대입 접두 없음
  for (const c of [
    `grep -rn "127.0.0.1:${P}" src`, `rg "localhost:${P}" -l`, `echo "see http://localhost:${P} for dev" >> README.md`,
    `cat notes.txt | grep 127.0.0.1:${P}`, `printf "%s\\n" http://localhost:${P}`, `head -n5 f | grep localhost:${P}`,
    `sort f | grep 127.0.0.1:${P}`, `echo http://127.0.0.1:${P}`,
  ]) assert.equal(await shellCallsArgoApi(c, own), false, `언급 통과: ${c}`);
  // 거절 — 이번 지적 계열(명령 치환·awk system·sed e·git -c·| sh·xargs·env·heredoc·대입 접두·실행도구·IP 표기) + 지난 목록. ownPort라 탐침 없이 참.
  for (const c of [
    `echo $(curl http://127.0.0.1:${P}/api/x)`, `X=$(cat f); grep 127.0.0.1:${P} f`,
    `awk 'BEGIN{system("curl http://127.0.0.1:${P}")}'`, `sed 's/x/y/e' <<< 'curl http://127.0.0.1:${P}'`,
    `git -c http.proxy=http://127.0.0.1:${P} fetch`, `grep x f | sh -c "curl http://127.0.0.1:${P}"`,
    `echo http://127.0.0.1:${P} | xargs curl`, `env X=1 curl http://127.0.0.1:${P}`,
    `cat <<EOF\ncurl http://127.0.0.1:${P}\nEOF`, `eval "curl http://127.0.0.1:${P}"`, `source ./x.sh # http://127.0.0.1:${P}`,
    'grep foo `curl http://127.0.0.1:' + P + '`', `echo x > /dev/tcp/127.0.0.1/${P}`, `VAR=curl; $VAR http://127.0.0.1:${P}`,
    `LC_ALL=C grep 127.0.0.1:${P} f`, `awk "/127.0.0.1:${P}/" f`, `sed -n /127.0.0.1:${P}/p f`, `find . -name 127.0.0.1:${P}`,
    'curl http://127.1:' + P + '/', 'wget http://0x7f000001:' + P + '/', 'aria2c http://2130706433:' + P + '/', `wget http://[::1]:${P}/`, `curl http://0.0.0.0:${P}/`,
    `exec 3<>/dev/tcp/127.0.0.1/${P}`, `python3 -c "import socket; socket.socket().connect(('127.0.0.1',${P}))"`,
    `ruby -rsocket -e "TCPSocket.new('127.0.0.1',${P})"`, `perl -MIO::Socket::INET -e "IO::Socket::INET->new('127.0.0.1:${P}')"`,
    '/opt/homebrew/bin/curl http://127.0.0.1:' + P + '/', '~/bin/curl http://127.0.0.1:' + P + '/',
    `pwsh -c "Invoke-RestMethod http://127.0.0.1:${P}"`, `powershell -Command "iwr http://127.0.0.1:${P}"`,
    `open -g http://127.0.0.1:${P}/`, `python3 req.py 127.0.0.1 ${P}`, `node -e "fetch('http://127.0.0.1:${P}/')"`, `printf x | nc 127.0.0.1 ${P}`,
    `echo "http://127.0.0.1:${P}`, `grep '127.0.0.1:${P} f`, // 따옴표 불균형 — 확신 못 하면 거절
  ]) assert.equal(await shellCallsArgoApi(c, own), true, `거절 대상: ${c}`);
});

test('권한 게이트 배선 — 모든 턴(주인 턴 포함)에서 Argo API 셸은 거절 + 이유 안내, 다른 셸은 종전대로', async () => {
  const ROOT = join(process.env.ARGO_ROOT, 'gateco'); await mkdir(ROOT, { recursive: true });
  const prev = process.env.PORT; process.env.PORT = String(ARGO); // Next가 listen 뒤 process.env.PORT에 적는 값 — 이 서버의 포트
  try {
    for (const g of [makePermissionGate('gateco', 'x', ROOT), makePermissionGate('gateco', 'x', ROOT, null, 'ko', [], { msgr: { orgId: 'o', channelId: 'c', crewId: 'k' } })]) {
      const d = await g('Bash', { command: `curl -s -X DELETE -H 'Cookie: argo-device=1' 'http://127.0.0.1:${ARGO}/api/companies/gateco/routines?id=r1'` });
      assert.equal(d.behavior, 'deny');
      assert.match(d.message, /Argo 앱의 API를 직접 부릅니다/);
      assert.equal((await g('Bash', { command: `curl -s -X POST http://localhost:${ARGO}/api/companies/gateco/approvals -d '{"id":"a","approve":true}'` })).behavior, 'deny', '결재 자가 승인');
      assert.equal((await g('Bash', { command: `curl -s http://127.0.0.1:${OTHER}/health` })).behavior, 'allow', '다른 로컬 서버');
      assert.equal((await g('Bash', { command: 'curl -s https://example.com/' })).behavior, 'allow');
      assert.equal((await g('Bash', { command: 'ls -la' })).behavior, 'allow');
    }
    const en = makePermissionGate('gateco', 'x', ROOT, null, 'en');
    assert.match((await en('Bash', { command: `curl http://127.0.0.1:${ARGO}/api/x` })).message, /cannot call this API/);
  } finally { if (prev === undefined) delete process.env.PORT; else process.env.PORT = prev; }
});
