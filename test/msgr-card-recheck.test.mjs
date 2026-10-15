// 앱↔메신저 연결 감사 D4(2026-10-15) — 메신저에서 조직을 만들고 데스크톱으로 돌아와도 연결 카드가 옛 판정('다른 계정으로 로그인'만)을 보였다.
// 카드는 내 행이 0이고 계정이 맞으면 이미 [지금 연결](POST reconnect — 자동 켜기 10분 캐시 없이 바로 켠다)을 보이지만, 탭으로 돌아와도 다시 읽지 않았다.
// 여기서 잠그는 것: ① 탭 복귀 다시 읽기 판정(보일 때만·5초 안 중복 접기) ② D3 '곧 연결' 상태의 상한 2분(검수 미룸) ③ 이유 판정은 그대로(핀).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { msgrSetupReason, msgrCardView, personalCardView, pausedLabelKey } from '../app/c/[ws]/settings/msgr-card.mjs';

const card = await import('../app/c/[ws]/settings/msgr-card.mjs');

test('① 탭 복귀 다시 읽기 — 보이는 탭에서만, focus·visibilitychange가 같이 튀어도 5초 안 한 번', () => {
  const { tabReturnDue } = card;
  assert.equal(typeof tabReturnDue, 'function');
  assert.equal(tabReturnDue({ visible: true, now: 10_000, last: 0 }), true);
  assert.equal(tabReturnDue({ visible: false, now: 10_000, last: 0 }), false, '숨은 탭은 읽지 않는다');
  assert.equal(tabReturnDue({ visible: true, now: 10_000, last: 6_000 }), false, '5초 안 중복');
  assert.equal(tabReturnDue({ visible: true, now: 11_001, last: 6_000 }), true);
});

test('① 화면 배선 — 연결 카드가 탭 복귀 판정으로 load()를 다시 부른다(설정 화면을 연 동안만, 해제 때 정리)', () => {
  const page = readFileSync(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  const msgr = page.slice(page.indexOf('function MsgrCard('), page.indexOf('function withMailto('));
  assert.match(msgr, /tabReturnDue\(\{ visible: document\.visibilityState === 'visible', now, last: lastBack\.current \}\)/);
  assert.match(msgr, /document\.addEventListener\('visibilitychange', onBack\);\s*window\.addEventListener\('focus', onBack\);/);
  assert.match(msgr, /return \(\) => \{ document\.removeEventListener\('visibilitychange', onBack\); window\.removeEventListener\('focus', onBack\); \};/);
});

const st = (over = {}) => ({ signedIn: true, crews: [{ org_id: 'o', slug: 'a', status: 'paused' }], pauseReason: 'app', pauseAppOk: true, runtime: { state: 'alive' }, ...over });
test('② 곧 연결 상한 — 처음 본 뒤 2분이 지나면 종전 문구·폴 멈춤, 2분 안·시각 모름은 곧 연결', () => {
  const A = [{ slug: 'a' }];
  assert.equal(msgrCardView({ st: st(), orgId: 'o', agents: A, soonSince: 0, now: 119_999 }).soon, true);
  const late = msgrCardView({ st: st(), orgId: 'o', agents: A, soonSince: 0, now: 120_000 });
  assert.equal(late.soon, false, '2분 지남 — 첫 심박이 안 오면 곧 연결이라고 계속 말하지 않는다');
  assert.equal(late.polling, false, '활성 행이 없으면 폴도 멈춘다(8초 GET 상한 15회)');
  assert.equal(msgrCardView({ st: st(), orgId: 'o', agents: A }).soon, true, '시각을 안 넘기면(옛 호출) 종전 판정');
  assert.equal(pausedLabelKey('app', { soon: late.soon }), 'settings.msgr.paused.app');
  const per = personalCardView({ st: { ...st({ crews: [], orgs: [] }), personal: [{ slug: 'a', status: 'paused' }] }, agents: A, soon: false });
  assert.equal(per.rows[0].labelKey, 'settings.msgr.paused.app', '개인 공간 줄도 상한을 지난 판정을 받는다');
});

test('② 화면 배선 — 곧 연결을 처음 본 시각을 들고, 풀리면 지운다(다시 곧 연결이면 처음부터 2분)', () => {
  const page = readFileSync(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  const msgr = page.slice(page.indexOf('function MsgrCard('), page.indexOf('function withMailto('));
  assert.match(msgr, /setSoonSince\(\(s\) => \(rawSoon \? \(s \?\? Date\.now\(\)\) : null\)\)/);
  assert.match(msgr, /msgrCardView\(\{ st, orgId, agents, soonSince \}\)/);
  assert.match(msgr, /personalCardView\(\{ st, agents, soon: view\.soon \}\)/);
});

test('③ 핀 — 내 행 0일 때 이유 판정은 그대로: 소유자 아님 → owner, 조직·프로필 없음 → account, 그 밖 → pending + 지금 연결', () => {
  const s = (setup, orgs = []) => ({ st: { signedIn: true, orgs, setup } });
  assert.deepEqual(msgrSetupReason(s({ owner: false })), { reason: 'owner', action: 'login' });
  assert.deepEqual(msgrSetupReason(s({ owner: true, profile: false })), { reason: 'account', action: 'login' });
  assert.deepEqual(msgrSetupReason(s({ owner: true, profile: false }, [{ id: 'o' }])), { reason: 'pending', action: 'connect' }, '조직이 생기면(메신저에서 만듦) 지금 연결');
  assert.deepEqual(msgrSetupReason(s({ owner: true, profile: true })), { reason: 'pending', action: 'connect' });
  assert.equal(msgrSetupReason({ st: { signedIn: true, orgs: [] } }), null, '옛 서버(setup 없음)');
});
