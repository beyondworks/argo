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

test('판정 — 루프백 Argo 주소·포트가 명령에 보이면 무조건 거절(언급 통과 없음), 주소가 없거나 다른 포트면 통과', async () => {
  const noProbe = async () => { throw new Error('탐침하면 안 된다'); };
  const own = { ownPort: 3477, probe: noProbe };
  const P = 3477;
  // 통과 — 루프백 호스트가 아예 없거나(포트 숫자만/원격), 루프백이어도 다른(비-Argo) 포트
  assert.equal(await shellCallsArgoApi('curl https://example.com/', own), false, '원격');
  assert.equal(await shellCallsArgoApi('grep 3477 src', own), false, '포트 숫자만, 루프백 호스트 없음');
  assert.equal(await shellCallsArgoApi('grep localhost src', own), false, '호스트만, 포트 없음');
  assert.equal(await shellCallsArgoApi(`curl http://127.0.0.1:${OTHER}/api/items`, { ownPort: 0 }), false, '사용자의 다른 로컬 서버(비-Argo 포트)는 그대로');
  assert.equal(await probeArgoPort(OTHER), false);
  assert.equal(await probeArgoPort(ARGO), true);
  // 거절 — 루프백 Argo 주소+포트가 보이면 도구·구문 불문. '안전해 보이는' grep·echo·cat도 더는 예외가 아니다(allowlist-semantic-escape 종식).
  for (const c of [
    // 예전 '언급 통과'였던 것들 — 이제 전부 거절(주소가 보이므로)
    `grep -rn "127.0.0.1:${P}" src`, `rg "localhost:${P}" -l`, `echo "see http://localhost:${P}" >> README.md`,
    `cat notes.txt | grep 127.0.0.1:${P}`, `printf "%s" http://localhost:${P}`, `echo http://127.0.0.1:${P}`, `sort f | grep 127.0.0.1:${P}`,
    // 허용목록 탈출 계열(rg --pre·sort --compress-program·less LESSOPEN·env 할당 접두)
    `rg --pre=curl "x" http://127.0.0.1:${P}`, `sort --compress-program=curl f # 127.0.0.1:${P}`,
    `LESSOPEN='|curl http://127.0.0.1:${P} %s' less f`, `PAGER='curl http://127.0.0.1:${P}' less f`, `GREP_OPTIONS=x grep 127.0.0.1:${P} f`,
    // 치환·실행 계열
    `echo $(curl http://127.0.0.1:${P}/api/x)`, `X=$(cat f); grep 127.0.0.1:${P} f`,
    `awk 'BEGIN{system("curl http://127.0.0.1:${P}")}'`, `git -c http.proxy=http://127.0.0.1:${P} fetch`,
    `grep x f | sh -c "curl http://127.0.0.1:${P}"`, `echo http://127.0.0.1:${P} | xargs curl`, `env X=1 curl http://127.0.0.1:${P}`,
    `cat <<EOF\ncurl http://127.0.0.1:${P}\nEOF`, `eval "curl http://127.0.0.1:${P}"`, 'grep foo `curl http://127.0.0.1:' + P + '`',
    `echo x > /dev/tcp/127.0.0.1/${P}`, `VAR=curl; $VAR http://127.0.0.1:${P}`, `LC_ALL=C grep 127.0.0.1:${P} f`,
    // IP 표기 변형
    'curl http://127.1:' + P + '/', 'wget http://0x7f000001:' + P + '/', 'aria2c http://2130706433:' + P + '/', `wget http://[::1]:${P}/`, `curl http://0.0.0.0:${P}/`,
    // 소켓·인터프리터·경로접두·셸
    `exec 3<>/dev/tcp/127.0.0.1/${P}`, `python3 -c "import socket; socket.socket().connect(('127.0.0.1',${P}))"`,
    `ruby -rsocket -e "TCPSocket.new('127.0.0.1',${P})"`, `perl -MIO::Socket::INET -e "IO::Socket::INET->new('127.0.0.1:${P}')"`,
    '/opt/homebrew/bin/curl http://127.0.0.1:' + P + '/', '~/bin/curl http://127.0.0.1:' + P + '/',
    `pwsh -c "Invoke-RestMethod http://127.0.0.1:${P}"`, `powershell -Command "iwr http://127.0.0.1:${P}"`,
    `open -g http://127.0.0.1:${P}/`, `python3 req.py 127.0.0.1 ${P}`, `node -e "fetch('http://127.0.0.1:${P}/')"`, `printf x | nc 127.0.0.1 ${P}`,
    `curl -X DELETE http://localhost:${P}/api/companies/w/routines?id=r`,
  ]) assert.equal(await shellCallsArgoApi(c, own), true, `거절 대상: ${c}`);
});

test('권한 게이트 배선 — 모든 턴(주인 턴 포함)에서 Argo API 셸은 거절 + 이유 안내, 다른 셸은 종전대로', async () => {
  const ROOT = join(process.env.ARGO_ROOT, 'gateco'); await mkdir(ROOT, { recursive: true });
  const prev = process.env.PORT; process.env.PORT = String(ARGO); // Next가 listen 뒤 process.env.PORT에 적는 값 — 이 서버의 포트
  try {
    for (const g of [makePermissionGate('gateco', 'x', ROOT), makePermissionGate('gateco', 'x', ROOT, null, 'ko', [], { msgr: { orgId: 'o', channelId: 'c', crewId: 'k' } })]) {
      const d = await g('Bash', { command: `curl -s -X DELETE -H 'Cookie: argo-device=1' 'http://127.0.0.1:${ARGO}/api/companies/gateco/routines?id=r1'` });
      assert.equal(d.behavior, 'deny');
      assert.match(d.message, /루프백 주소가 들어 있습니다/);
      assert.equal((await g('Bash', { command: `curl -s -X POST http://localhost:${ARGO}/api/companies/gateco/approvals -d '{"id":"a","approve":true}'` })).behavior, 'deny', '결재 자가 승인');
      assert.equal((await g('Bash', { command: `curl -s http://127.0.0.1:${OTHER}/health` })).behavior, 'allow', '다른 로컬 서버');
      assert.equal((await g('Bash', { command: 'curl -s https://example.com/' })).behavior, 'allow');
      assert.equal((await g('Bash', { command: 'ls -la' })).behavior, 'allow');
    }
    const en = makePermissionGate('gateco', 'x', ROOT, null, 'en');
    assert.match((await en('Bash', { command: `curl http://127.0.0.1:${ARGO}/api/x` })).message, /cannot call this API/);
  } finally { if (prev === undefined) delete process.env.PORT; else process.env.PORT = prev; }
});

// #918 후속(Windows 한계 ①) — Windows는 서버 판정이 기본 꺼짐이라 이 게이트가 유일한 방어인데, 포트를 환경 변수로 조립하면 리터럴 포트가 없어 통과했다(재현 2026-10-10).
test('판정 — 루프백 호스트와 포트 환경 변수 참조($PORT·${PORT}·%PORT%·$env:PORT 등)가 함께 보이면 거절, Next 서버 주소 변수는 호스트 없이도 거절', async () => {
  const own = { ownPort: 3477, probe: async () => false };
  for (const c of [
    'curl -X DELETE http://127.0.0.1:$PORT/api/companies/w/routines?id=r', 'curl "http://localhost:${PORT}/api/x"', 'curl http://localhost:${PORT:-3001}/api/x',
    'curl http://127.0.0.1:%PORT%/api/x', 'curl http://127.0.0.1:%port%/api/x', 'curl http://127.0.0.1:!PORT!/api/x',
    'iwr http://localhost:$env:PORT/api/x', 'Invoke-RestMethod "http://127.0.0.1:$Env:port/api/x" -Method Post',
    `python3 -c "import os,urllib.request as u; u.urlopen('http://127.0.0.1:'+os.environ['PORT']+'/api/x')"`, `node -e "fetch('http://localhost:'+process.env.PORT+'/api/x')"`,
    `ruby -e "require 'net/http'; Net::HTTP.get(URI('http://127.0.0.1:'+ENV['PORT']+'/api/x'))"`, 'curl http://[::1]:$(printenv PORT)/api/x',
    'curl $__NEXT_PRIVATE_ORIGIN/api/companies/w/approvals', `node -e "fetch(process.env.__NEXT_PRIVATE_ORIGIN+'/api/x')"`,
    // 검수 #920이 찾은 누락 표기
    'iwr "http://127.0.0.1:${env:PORT}/api/x"', 'iwr ("http://127.0.0.1:" + (Get-ChildItem env:PORT).Value)', 'iwr ("http://127.0.0.1:" + (gci Env:PORT).Value)',
    `perl -MLWP::Simple -e 'get("http://127.0.0.1:$ENV{PORT}/api/x")'`, `node -e "fetch('http://localhost:'+process.env?.PORT)"`, 'node -e "fetch(\'http://localhost:\'+process.env[`PORT`])"',
    `python3 -c "import os; print('http://127.0.0.1:'+os.environ.get('PORT'))"`, `[Environment]::GetEnvironmentVariable('PORT') ; iwr http://127.0.0.1:1/`,
  ]) assert.equal(await shellCallsArgoApi(c, own), true, `거절 대상: ${c}`);
  for (const c of [
    'echo $PORT', 'PORT=5173 npm run dev', 'grep -rn PORT src', // 루프백 호스트 없음
    'PORT=5173 npm run dev & sleep 2; curl http://localhost:5173/', // 포트 대입만 있고 참조 없음 — 사용자의 개발 서버
    'curl http://127.0.0.1:5173/api/report', 'curl https://example.com:$PORT/', // 다른 로컬 포트 / 원격
    // 검수 #920: 에이전트가 같은 명령에서 PORT를 직접 정한 개발 작업 — env를 지웠으니 그 $PORT는 에이전트 값이다
    'export PORT=5173; npm run dev & sleep 3; curl http://localhost:$PORT/', 'set PORT=5173 && npm run dev & curl http://localhost:%PORT%/',
    '$env:PORT = 5173; npm run dev; iwr http://localhost:$env:PORT/', 'docker run -e "PORT=8080" -p 8080:8080 img && curl localhost:8080/health',
    `node -e "require('http').createServer().listen(process.env.PORT||4000)" & PORT=4000 curl localhost:4000`,
    'grep -n "PORT" .env.example && curl http://localhost:5173/', 'echo "PORT=3000" >> .env && npm run dev -- --hostname 127.0.0.1',
    'grep -rn __NEXT_PRIVATE_ORIGIN node_modules/next/dist/server/lib', // 이름 검색 — 참조가 아니다
  ]) assert.equal(await shellCallsArgoApi(c, own), false, `통과 대상: ${c}`);
  assert.equal(await shellCallsArgoApi('export PORT=3477; curl http://127.0.0.1:$PORT/api/x', own), true, '대입값이 리터럴 Argo 포트면 ownPort 판정이 잡는다');
});
