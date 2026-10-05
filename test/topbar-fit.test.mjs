// UM1(2026-10-05 분리 검수): '새 소식' 칩·'새로 고침 실패' 칩이 좁은 폭에서 상단바를 넘쳤다 —
// ① 칩이 생기거나 사라져도 상자 크기는 그대로라 ResizeObserver가 안 돌고 fitBar가 다시 측정하지 않았다(561 en: 상단바 21px·문서 13px 넘침, 접기 속성 없음)
// ② '새 소식'은 tasks.running이 blocked에 들어 있어 턴마다 칩이 사라졌다 생겼다(그때마다 폭이 바뀐다).
// 잠그는 행동(브라우저 없이): 상단바 안의 자식 변화를 관찰해 재측정을 부르는 배선(watchTopbarContent), 안내 차단 판정(updateNotesBlocked).
// 접기 CSS 자체(라벨 숨김)와 실제 넘침 0은 측정으로 확인한다 — display-zoom-layout.test.mjs의 배선 핀 + 폭별 측정 캡처.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchTopbarContent } from '../app/c/[ws]/topbar-fit.mjs';
import { updateNotesBlocked } from '../app/update-notes-state.mjs';

class FakeObserver {
  static last = null;
  constructor(cb) { this.cb = cb; this.observed = []; this.disconnected = false; FakeObserver.last = this; }
  observe(target, options) { this.observed.push([target, options]); }
  disconnect() { this.disconnected = true; }
}

test('상단바 안의 자식(칩·배지)이 생기거나 사라지면 재측정을 부른다 — 상자 크기가 안 변해도', () => {
  const bar = { id: 'bar' };
  let fits = 0;
  const stop = watchTopbarContent(bar, () => { fits++; }, { MutationObserverImpl: FakeObserver });
  const mo = FakeObserver.last;
  assert.equal(mo.observed.length, 1);
  assert.equal(mo.observed[0][0], bar, '상단바를 관찰한다');
  assert.deepEqual(mo.observed[0][1], { childList: true, subtree: true }, '자식 추가·제거(칩은 포털로도 들어온다)만 — 속성 변화는 보지 않아 접기 속성 토글이 되먹임하지 않는다');
  mo.cb([{ type: 'childList' }]);
  assert.equal(fits, 1);
  stop();
  assert.equal(mo.disconnected, true);
});

test('상단바가 없거나 관찰기가 없는 환경은 조용히 건너뛴다', () => {
  assert.equal(typeof watchTopbarContent(null, () => {}, { MutationObserverImpl: FakeObserver }), 'function');
  assert.equal(typeof watchTopbarContent({}, () => {}, { MutationObserverImpl: undefined }), 'function');
});

test('안내 칩은 턴이 도는 동안에도 사라지지 않는다 — 실행 중 턴은 차단 조건이 아니다', () => {
  const base = { data: { company: {} }, tasks: { running: [] }, dockOpen: false, fbOpen: false, renameTeam: null, updPhase: 'idle' };
  assert.equal(updateNotesBlocked(base), false);
  assert.equal(updateNotesBlocked({ ...base, tasks: { running: [{ slug: 'a' }] } }), false, '실행 중 턴이 있어도 칩은 그대로(턴마다 폭이 바뀌어 상단바가 흔들리던 것)');
  for (const patch of [{ data: null }, { data: { missing: true } }, { data: { loadError: true } }, { tasks: null }, { dockOpen: true }, { fbOpen: true }, { renameTeam: 'x' }, { updPhase: 'checking' }, { updPhase: 'installing' }, { updPhase: 'ready' }]) {
    assert.equal(updateNotesBlocked({ ...base, ...patch }), true, JSON.stringify(patch));
  }
  assert.equal(updateNotesBlocked({ ...base, renameTeam: '' }), true, '빈 문자열 팀 이름 입력 중도 열린 입력창이다');
});
