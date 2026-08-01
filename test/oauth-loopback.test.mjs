// OAuth 루프백 주소 계약 — 리스너가 여는 곳과 브라우저가 찾아오는 곳이 같아야 한다.
//
// 사용자 제보(2026-08-01): gemini 로그인에서 `localhost:45289` 접근이 실패했다. 리스너는 원래부터
// 127.0.0.1(IPv4)에만 바인딩하는데 redirect 주소를 'localhost'로 줬다 — 브라우저가 그걸 ::1(IPv6)로
// 먼저 풀면 IPv4에만 열린 리스너에 못 닿는다. IPv4 폴백이 항상 되는 건 아니다(이 레포는 happy-eyeballs
// 계열 파손을 이미 겪었다). 구글이 이 클라이언트에 127.0.0.1을 받는 것은 실측 확인했다.
//
// 여기서 잠그는 계약:
//  ① 리스너 바인딩은 루프백 IP 리터럴 — 한 글자 바뀌면 LAN에 열린다.
//  ② 우리가 만드는 콜백 주소(커넥터)는 IP 리터럴 — 이름 해석에 기대지 않는다.
//  ③ 벤더 등록 콜백은 **검증한 것만** 바꾼다. codex는 판정 불가라 그대로 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('러너 로그인 리스너가 루프백 IP에 바인딩한다 — 이름이 아니라', () => {
  const s = read('../src/runners/webauth.mjs');
  assert.match(s, /srv\.listen\(Number\(target\.port\), '127\.0\.0\.1'\)/,
    '리스너 바인딩이 루프백 IP 리터럴이 아니다 — 이름으로 열면 LAN 노출이나 주소 불일치가 생긴다');
});

test('구글(gemini) 콜백은 IP 리터럴 — 브라우저의 이름 해석에 기대지 않는다', () => {
  const s = read('../src/runners/webauth.mjs');
  assert.match(s, /redirect: 'http:\/\/127\.0\.0\.1:45289\/oauth2callback'/,
    'localhost로 되돌아갔다 — IPv6로 풀리면 리스너에 못 닿아 "사이트에 연결할 수 없음"이 뜬다');
});

test('codex 콜백은 벤더 등록값 그대로 — 판정 못 한 것을 추측으로 바꾸지 않는다', () => {
  // OpenAI 인가 엔드포인트는 무자격 요청에 전부 403을 줘서 127.0.0.1 수용 여부를 잴 수 없었다
  // (대조군도 403이라 판정력 자체가 없다). 되던 로그인을 추측으로 깨뜨리지 않는다.
  const s = read('../src/runners/webauth.mjs');
  assert.match(s, /redirect: 'http:\/\/localhost:1455\/auth\/callback'/,
    'codex 콜백이 바뀌었다 — 벤더 등록값과 어긋나면 로그인이 통째로 깨진다. 바꾸려면 실계정 검증 먼저');
});

test('커넥터 콜백 주소도 IP 리터럴 — 우리가 만드는 주소다', () => {
  const s = read('../src/connectors.mjs');
  assert.match(s, /const LOOPBACK = '127\.0\.0\.1';/);
  assert.match(s, /const redirectUrl = `http:\/\/\$\{LOOPBACK\}:\$\{bound\.port\}\$\{cbPath\}`/,
    '콜백 주소가 IP 리터럴로 조립되지 않는다');
  // 바인드 실측 검증도 리터럴로 비교해야 한다 — 상수와 대조하면 상수를 바꾼 변이가 스스로를 통과시킨다.
  assert.match(s, /bound\?\.address !== '127\.0\.0\.1'/, '바인드 검증이 자기참조 앵커가 됐다');
});
