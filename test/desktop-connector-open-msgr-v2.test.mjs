// 2026-10-28 제보(0.1.118 Windows): ① 커넥터 '연결'을 눌러도 브라우저가 안 뜸(앱 웹뷰는 window.open을 무시) ② 메신저 재오픈 뒤에도 설정이
// '메신저 출시 알림 받기'만 보이고 응답 상태가 '응답을 확인하지 못함'(옛 중단 스위치·옛 브리지 기준). 두 판정을 행동으로 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAuthUrl } from '../app/c/[ws]/settings/connector-open.mjs';
import { msgrPausedView } from '../app/c/[ws]/settings/msgr-card.mjs';
import { msgrV2Mode } from '../src/agent-link-flags.mjs';

test('커넥터 인가 창: 앱이면 시스템 브라우저(openUrl)로 열고 window.open은 부르지 않는다, 브라우저면 종전처럼 새 창', async () => {
  const calls = [];
  const deps = (tauri, fail = false) => ({ tauri, openUrl: async (u) => { calls.push(['openUrl', u]); if (fail) throw new Error('scope'); }, windowOpen: (...a) => calls.push(['windowOpen', ...a]) });
  assert.equal(await openAuthUrl('https://accounts.google.com/o/oauth2/auth?x=1', deps(true)), true);
  assert.deepEqual(calls, [['openUrl', 'https://accounts.google.com/o/oauth2/auth?x=1']], '앱: openUrl 하나, window.open 없음');
  calls.length = 0;
  assert.equal(await openAuthUrl('https://a.example/auth', deps(true, true)), false, '앱에서 열기 실패는 false(호출부가 안내)');
  assert.deepEqual(calls.map((c) => c[0]), ['openUrl'], '실패해도 window.open으로 떨어지지 않는다(앱은 무시하므로 조용한 실패가 된다)');
  calls.length = 0;
  assert.equal(await openAuthUrl('https://a.example/auth', deps(false)), true);
  assert.deepEqual(calls, [['windowOpen', 'https://a.example/auth', '_blank', 'noopener,noreferrer']], '브라우저: 종전 그대로');
});

test('설정 메신저 카드: 새 메신저 연결(v2)이면 중단 스위치와 상관없이 v2 카드, 아니면 종전 판정 그대로', () => {
  assert.equal(msgrPausedView(true, { known: true, v2: true }).msgrCard, 'v2', '옛 중단 스위치가 켜져 있어도 새 메신저 앱은 출시 알림 카드가 아니다');
  assert.equal(msgrPausedView(false, { known: true, v2: true }).msgrCard, 'v2', '옛 브리지 응답 상태 카드(full)도 아니다');
  assert.equal(msgrPausedView(true, { known: false, v2: true }).msgrCard, 'pending', '응답 전에는 자리를 비운다(깜빡임 방지 그대로)');
  assert.deepEqual(msgrPausedView(true, { known: true }), { showMsgrNotify: false, msgrCard: 'waitlist', noticeSettingsLink: false }, 'v2 아님: 종전');
  assert.deepEqual(msgrPausedView(false, { known: true }), { showMsgrNotify: true, msgrCard: 'full', noticeSettingsLink: true }, 'v2 아님: 종전');
  assert.equal(msgrPausedView(true, { known: true, v2: true }).showMsgrNotify, false, '알림 받을 메신저 줄은 종전처럼 중단 스위치를 따른다');
});

test('msgrV2Mode: 기본(환경 변수 없음) = 새 연결만, 옛 브리지를 켜거나 새 연결을 끄면 아님', () => {
  assert.equal(msgrV2Mode({}), true, '0.1.115부터 기본값');
  assert.equal(msgrV2Mode({ ARGO_MSGR_LEGACY: 'on' }), false);
  assert.equal(msgrV2Mode({ ARGO_AGENT_LINK: '0' }), false);
});
