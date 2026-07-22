// 신형 claude CLI(2.1.x) setup-token 코드 플로우 회귀 — 실측(2026-07-22) 고정.
// CLI가 localhost 자동 콜백 → "브라우저에 코드 표시 + 터미널 입력" 방식으로 바뀌어,
// stdin 없는 PTY 대행은 영원히 완주 불가였다(신규 기기 원클릭 실패 신고의 근본).
// 계약: PTY 출력에서 ① 인증 URL(브라우저 미개방 폴백 링크) ② 코드 프롬프트를 관측할 수 있어야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-setupcode-'));
const { extractSetupAuthUrl, submitSetupCode } = await import('../src/runners.mjs');

// 실측 PTY 출력(ANSI 제거 후) — 80칸 줄바꿈으로 URL이 여러 줄에 감긴 형태 그대로
const PTY_OUT = `Browser didn't open?Use the urlbelowtosignin(ctocopy)
https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88
ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co
m%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=JAX7si5ZVN1Dj1
K9_x8lCC5NRDtOZtl-k93HbbQg85M&code_challenge_method=S256&state=7enISOR3jleH9Y723
S6rzOEtcK466Lpz-ZWfoEwXYG0
Pastecodehereifprompted>`;

test('extractSetupAuthUrl: PTY 줄바꿈에 감긴 인증 URL을 접합 복원한다', () => {
  const url = extractSetupAuthUrl(PTY_OUT);
  assert.ok(url?.startsWith('https://claude.com/cai/oauth/authorize?code=true'), `url=${url}`);
  assert.ok(url.includes('code_challenge_method=S256'), 'URL 뒷부분(줄바꿈 3회 이후)까지 온전');
  assert.ok(!/\s/.test(url), '개행·공백 없는 단일 URL');
  // 빈 줄 없이 바로 이어지는 프롬프트 문구가 state 값에 접합되지 않는다(검수 MED — 오염된 링크는 로그인 실패)
  assert.ok(url.endsWith('S6rzOEtcK466Lpz-ZWfoEwXYG0'), `state 값에서 깨끗하게 끝나야 함: …${url.slice(-40)}`);
});

test('extractSetupAuthUrl: URL이 없는 일반 출력은 null', () => {
  assert.equal(extractSetupAuthUrl('Welcome to Claude Code v2.1.206\nOpening browser…'), null);
});

test('submitSetupCode: 실행 중인 시도가 없으면 not-running, 개행 포함 코드는 거절', () => {
  assert.deepEqual(submitSetupCode('no-such-ws', 'abc'), { ok: false, reason: 'not-running' });
  // 실행 중 상태를 흉내 — write 스파이로 stdin 전달 계약 확인
  const wrote = [];
  globalThis.__argoSetupToken['ws-x'] = { status: 'running', gen: 1, write: (s) => wrote.push(s) };
  assert.deepEqual(submitSetupCode('ws-x', 'evil\ncode'), { ok: false, reason: 'bad-code' });
  assert.equal(submitSetupCode('ws-x', '  ac_1234  ').ok, true, '트림 후 전달');
  assert.deepEqual(wrote, ['ac_1234\n'], '코드 + 개행 1회만 stdin으로');
  delete globalThis.__argoSetupToken['ws-x'];
});
