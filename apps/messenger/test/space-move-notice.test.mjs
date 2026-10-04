// 공간 전환 안내(유건 2026-10-04) — 조직 화면에서 내 에이전트 1:1을 눌러 앱이 개인 공간으로 옮겨 간 직후 한 줄 안내(기존 토스트), 누르면 직전 조직·채널로.
// 띄울지·돌아갈 곳은 순수 함수(agent-groups.mjs spaceMoveNotice·spaceMoveBack), 문구는 사전 + koJosa. App 배선은 test/agent-one-room.test.mjs(소스 핀).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spaceMoveNotice, spaceMoveBack, MOVE_NOTICE_MS } from '../src/agent-groups.mjs';
import { t } from '../src/i18n.js';
import { koJosa } from '../src/ko-josa.mjs';
import { toastMs } from '../src/phone-lists.mjs';

const P = '__personal__'; const LEAN = 'org-lean'; const CH = 'ch-general';

test('조직에서 개인 1:1로 옮겨 가면 띄운다 — 돌아갈 곳은 직전 조직과 그 조직에서 보던 채널', () => {
  assert.deepEqual(spaceMoveNotice({ from: LEAN, fromCh: CH, to: P, personalKey: P }), { backTo: LEAN, backCh: CH });
  assert.deepEqual(spaceMoveNotice({ from: LEAN, to: P, source: 'rail', personalKey: P }), { backTo: LEAN, backCh: null }, '보던 채널이 없으면 조직만(그 조직의 마지막 채널로 열린다)');
});

test('띄우지 않는다 — 폰 에이전트 탭에서 열었을 때, 이미 개인 공간이었을 때, 조직 경로로 갔을 때', () => {
  assert.equal(spaceMoveNotice({ from: LEAN, fromCh: CH, to: P, source: 'agents', personalKey: P }), null, '폰 에이전트 탭(모든 공간을 보는 화면)');
  assert.equal(spaceMoveNotice({ from: P, fromCh: 'ch-dm', to: P, personalKey: P }), null, '이미 개인 공간');
  assert.equal(spaceMoveNotice({ from: LEAN, fromCh: CH, to: LEAN, personalKey: P }), null, '조직 1:1로 감(개인 행 없음·준비 안 된 쌍둥이)');
  assert.equal(spaceMoveNotice({ from: null, to: P, personalKey: P }), null, '공간을 모름');
});

test('돌아가기 — 직전 조직(전환 직전 orgId)과 채널로, 그 사이 조직을 나갔으면 돌아가지 않는다', () => {
  const n = spaceMoveNotice({ from: LEAN, fromCh: CH, to: P, personalKey: P });
  assert.deepEqual(spaceMoveBack(n, [{ id: 'org-design' }, { id: LEAN }]), { space: LEAN, ch: CH });
  assert.equal(spaceMoveBack(n, [{ id: 'org-design' }]), null, '조직 목록에 없음');
  assert.equal(spaceMoveBack(null, [{ id: LEAN }]), null);
  assert.equal(spaceMoveBack(n, null), null);
});

test('문구 — ko는 조직 이름 받침에 맞춰 "으로/로"(koJosa), en은 그대로', () => {
  const ko = (org) => koJosa(t('personal.moved', 'ko', { name: '다빈치', org }));
  assert.equal(ko('Lean-AX'), '다빈치 1:1은 개인 공간에 있습니다 · Lean-AX로 돌아가기');
  assert.equal(ko('린팀'), '다빈치 1:1은 개인 공간에 있습니다 · 린팀으로 돌아가기');
  assert.equal(ko('아르고'), '다빈치 1:1은 개인 공간에 있습니다 · 아르고로 돌아가기');
  assert.equal(ko('서울'), '다빈치 1:1은 개인 공간에 있습니다 · 서울로 돌아가기', 'ㄹ 받침은 "로"');
  assert.equal(t('personal.moved', 'en', { name: 'Davinci', org: 'Lean-AX' }), "Davinci's 1:1 lives in your personal space · Back to Lean-AX");
  assert.equal(t('ui.dm.personal', 'ko'), '개인 1:1 대화'); assert.equal(t('ui.dm.personal', 'en'), 'Personal 1:1');
  assert.equal(t('mention.outside.dm.personal', 'ko'), '개인 1:1로 시키기'); assert.equal(t('mention.outside.dm.personal', 'en'), 'Ask in personal 1:1');
});

test('안내는 기존 토스트 시간 규칙(toastMs의 문구별 시간)으로 6초 — 보통 안내 4초보다 길다', () => {
  const text = koJosa(t('personal.moved', 'ko', { name: '다빈치', org: 'Lean-AX' }));
  assert.equal(MOVE_NOTICE_MS, 6000);
  assert.equal(toastMs({ err: '', note: text, flashed: { text, ms: MOVE_NOTICE_MS } }), 6000);
  assert.equal(toastMs({ err: '', note: '다른 안내', flashed: { text, ms: MOVE_NOTICE_MS } }), 4000, '그 사이 다른 안내가 뜨면 그 안내는 4초');
});
