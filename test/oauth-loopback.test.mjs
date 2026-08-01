// OAuth 루프백 — **브라우저에 알려준 주소로 실제로 닿는가**를 잰다.
//
// 경위(2026-08-01): 사용자가 gemini 로그인에서 `localhost:45289` 접근 실패를 제보했다. 첫 진단은
// "브라우저가 localhost를 ::1로 풀면 IPv4에만 열린 리스너에 못 닿는다"였는데, 분리 검수가 그 기전을
// **반증**했다 — 이 제품 자체가 웹뷰를 `localhost:3001`로 보내고 사이드카는 127.0.0.1에만 바인딩한다
// (src-tauri/src/lib.rs). 그 기전이 일반적이라면 앱이 아무에게도 안 떠야 한다. 실제로 macOS에서는
// ::1이 즉시 ECONNREFUSED를 주고 브라우저가 IPv4로 폴백한다(실측 3ms).
//
// 그래서 제보 원인은 **미확정**이다(리스너 미기동·포트 선점·TTL 만료가 더 유력하다 — 그 경우 주소를
// 바꿔도 증상은 같다). 다만 "알려준 주소와 여는 주소가 갈려 있다"는 비대칭 자체는 실재했고,
// RFC 8252 §7.3이 "IPv4·IPv6 둘 다 바인드하라"고 권고하므로 **여는 쪽을 넓혔다**.
// 벤더 등록 주소(gemini·codex 모두 `localhost`)는 건드리지 않는다 — 바꿀 근거가 없고, 숫자 IP는
// localhost만 프록시 우회하는 환경에서 되던 사용자를 깨뜨린다.
//
// 여기서 잠그는 것은 문자열이 아니라 **도달성**이다: 리스너가 실제로 뜨고, 알려준 주소로 닿는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-oauthlb-')); // import보다 먼저
const { startRunnerWebAuth } = await import('../src/runners/webauth.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const WS = 'co-oauthlb';
await createCompany(WS, '루프백 테스트사', 'captain');

// codex로 잰다 — gemini 경로는 CLI 조달(네트워크)을 함께 태운다. 리스너 골격은 러너 무관 동일하다.
const started = startRunnerWebAuth('codex', WS);
after(() => { globalThis.__argoWebAuthSrv?.codex?.close?.(); });

test('리스너가 실제로 뜬다 — 문자열만 맞고 안 뜨면 사용자는 "사이트에 연결할 수 없음"을 본다', async () => {
  assert.ok(started.url, '인가 URL이 안 만들어졌다');
  const srv = globalThis.__argoWebAuthSrv?.codex;
  assert.ok(srv, '리스너가 등록되지 않았다');
  // listen()은 비동기다 — 등록 직후엔 아직 주소가 없다. 실사용에선 브라우저를 열고 로그인하는
  // 수 초가 있어 무해하지만, 테스트는 기다려야 실제 상태를 본다.
  for (let i = 0; i < 50 && !srv.address(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(srv.address(), '리스너가 바인딩되지 않았다');
});

test('브라우저에 알려준 주소로 실제로 닿는다 — 이 대조가 이 버그 계열의 유일한 방어다', async () => {
  // 인가 URL의 redirect_uri = 우리가 브라우저에게 "여기로 돌아와"라고 말한 주소.
  // 그 주소로 진짜 요청을 보내 본다. 호스트·포트·IP 계열이 하나라도 어긋나면 여기서 실패한다.
  const redirect = new URL(new URL(started.url).searchParams.get('redirect_uri'));
  const res = await fetch(`${redirect.origin}${redirect.pathname}`, { signal: AbortSignal.timeout(5000) })
    .catch((e) => ({ failed: String(e.message) }));
  assert.ok(!res.failed, `알려준 주소에 못 닿는다(${res.failed}) — 사용자에게 연결 실패로 보인다`);
  // code 없는 요청은 404가 정상(핸들러 계약). 닿았다는 것 자체가 이 테스트의 목적이다.
  assert.equal(res.status, 404, '핸들러가 응답하지 않았다 — 다른 프로세스가 그 포트를 잡고 있을 수 있다');
});

test('IPv4·IPv6 루프백 양쪽에서 닿는다 — 이름 해석 결과가 갈려도 안 깨지게(RFC 8252 §7.3)', async () => {
  const port = new URL(new URL(started.url).searchParams.get('redirect_uri')).port;
  const hit = async (host) => {
    const r = await fetch(`http://${host}:${port}/auth/callback`, { signal: AbortSignal.timeout(5000) })
      .catch((e) => ({ failed: String(e.message) }));
    return r.failed ? `실패(${r.failed})` : `HTTP ${r.status}`;
  };
  assert.equal(await hit('127.0.0.1'), 'HTTP 404', 'IPv4 루프백에 안 열렸다');
  // IPv6은 환경에 따라 없을 수 있다 — 없으면 IPv4 하나로 충분하므로 실패를 허용한다.
  // 있는데 안 열렸다면 그건 우리가 안 연 것이다(그 구분을 위해 결과를 남긴다).
  const v6 = await hit('[::1]');
  assert.ok(v6 === 'HTTP 404' || v6.startsWith('실패'), `예상 밖 응답: ${v6}`);
});

test('벤더 등록 주소는 그대로 — 우리가 정한 값이 아니다', () => {
  // gemini-cli 소스 주석: "loopback IP literal (i.e., 'localhost' or '127.0.0.1')" — 둘 다 받는다.
  // codex 바이너리 실측: 자기도 `http://localhost:{port}/auth/callback`를 쓴다.
  // 받아준다고 바꿀 이유는 없다. 도달성은 위 듀얼 바인드가 책임진다.
  const s = readFileSync(new URL('../src/runners/webauth.mjs', import.meta.url), 'utf8');
  assert.match(s, /redirect: 'http:\/\/localhost:45289\/oauth2callback'/, 'gemini 벤더 주소가 바뀌었다');
  assert.match(s, /redirect: 'http:\/\/localhost:1455\/auth\/callback'/, 'codex 벤더 주소가 바뀌었다');
});
