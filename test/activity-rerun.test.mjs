// F5(2026-10-05 분리 검증): 활동 화면 '다시 실행'이 메신저(손님 포함) 턴을 사장 직접 턴으로 데스크톱 1:1에서 다시 돌렸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rerunMode } from '../app/c/[ws]/activity/rerun.mjs';

const turn = (extra) => ({ type: 'turn', slug: 'pepper', msg: '보고서 써줘', ...extra });

test('메신저 턴은 다시 실행을 숨기고 메신저에서 다시 보내라고 안내한다', () => {
  assert.equal(rerunMode(turn({ source: 'messenger' })), 'messenger');
});

test('사장이 직접 시킨 턴만 그 자리에서 다시 실행한다 — 다른 크루가 건 턴은 숨긴다', () => {
  for (const source of ['trial', 'room']) assert.equal(rerunMode(turn({ source })), 'rerun', String(source));
  for (const source of ['deck', 'routine']) assert.equal(rerunMode(turn({ source, ownerDirect: true })), 'rerun', `${source} — 사장 직접 턴 표지가 있을 때만(2차 검수 LOW-2)`);
  assert.equal(rerunMode(turn({})), 'none', 'source가 없는 이벤트는 출처를 증명할 수 없다 — 사장 직접 턴으로 다시 돌리지 않는다(보안 검토)');
  assert.equal(rerunMode(turn({ source: null })), 'none');
  assert.equal(rerunMode(turn({ source: 'deck', from: 'shuri' })), 'none', 'from이 있으면 deck이라도 숨긴다');
  assert.equal(rerunMode(turn({ source: 'catalog' })), 'none', '목록에 없는 출처는 숨긴다');
  assert.equal(rerunMode(turn({ source: 'crewmail', fromRole: 'captain' })), 'rerun', '사장 쪽지');
  assert.equal(rerunMode(turn({ source: 'delegate', from: 'shuri' })), 'none');
  assert.equal(rerunMode(turn({ source: 'crewmail', from: 'shuri' })), 'none');
  assert.equal(rerunMode(turn({ source: 'session', from: 'shuri' })), 'none');
  assert.equal(rerunMode(turn({ source: 'job' })), 'none', '장시간 작업은 메신저 발일 수 있어 승격하지 않는다');
  assert.equal(rerunMode(turn({ msg: '' })), 'none');
  assert.equal(rerunMode({ type: 'memory', msg: 'x' }), 'none');
});

// 2차 분리 검수 LOW-2(2026-10-05): 1차 M1 수정(notOwnerDirect 기록) 이전에 기록된 크루 루틴 이벤트·결재 후속 턴(approval-actions.mjs source 'deck' + notOwnerDirect) 이벤트는
// 출처 필드가 아무것도 없어 '다시 실행'이 보였다. 사장 직접 턴 표지(ownerDirect, chat.mjs가 !from && !notOwnerDirect일 때 적극 기록)를 필수로 해 옛 이벤트의 버튼을 숨긴다 —
// 사장이 만든 루틴·1:1의 옛 이벤트도 숨지만 안전한 쪽이고, 새로 실행한 턴부터는 다시 보인다.
test('routine·deck 출처는 사장 직접 턴 표지(ownerDirect)가 있을 때만 다시 실행 — 표지 없는 옛 이벤트는 숨긴다', () => {
  for (const source of ['routine', 'deck']) {
    assert.equal(rerunMode(turn({ source })), 'none', `${source}: 표지 없는 옛 이벤트(크루 루틴·결재 후속일 수 있다)`);
    assert.equal(rerunMode(turn({ source, ownerDirect: true })), 'rerun');
    assert.equal(rerunMode(turn({ source, ownerDirect: true, notOwnerDirect: 'shuri' })), 'none', '표지와 notOwnerDirect가 같이 있으면 숨긴다');
    assert.equal(rerunMode(turn({ source, ownerDirect: true, from: 'shuri' })), 'none');
    assert.equal(rerunMode(turn({ source, ownerDirect: false })), 'none');
  }
  assert.equal(rerunMode(turn({ source: 'messenger' })), 'messenger', '메신저 출처는 그대로');
});
