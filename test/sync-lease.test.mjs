// 리스 리더십 회귀 테스트 — architect REJECT 사유(이중 리더) 재발 방지.
// 핵심 불변식: 리스 쓰기 실패(= 판정 불가) 시 **확인된 CAS 획득자이고 TTL 내**일 때만 리더를 유지한다.
// 기본값 leader:true(= 동기화 off 단일 기기 전제, 미획득)를 "유지"로 판정하면 리스를 얻은 적 없는
// 프로세스가 리더로 굳어 루틴 이중 실행·이중 과금·텔레그램 409가 난다(수정 전 동작이 그랬다).
// 반대로 무조건 강등하면 일시 네트워크 장애로 루틴·폴러가 멈춘다 — 아래가 그 절충을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { holdsLeaseOnWriteFailure, LEASE_TTL_MS } from '../src/sync.mjs';

const NOW = 1_800_000_000_000; // 고정 시각(테스트 결정성)

test('미획득 기본값(leader:true, ownedAt:0) → 유지하지 않는다 [이중 리더 방지 핵심]', () => {
  assert.equal(holdsLeaseOnWriteFailure({ leader: true, ownedAt: 0 }, NOW), false);
});

test('확인된 보유자 + TTL 내 → 유지(일시 장애 흡수)', () => {
  assert.equal(holdsLeaseOnWriteFailure({ leader: true, ownedAt: NOW - 1_000 }, NOW), true);
});

test('확인된 보유자지만 TTL 경과 → 강등(지속 실패는 자연 수렴)', () => {
  assert.equal(holdsLeaseOnWriteFailure({ leader: true, ownedAt: NOW - LEASE_TTL_MS - 1 }, NOW), false);
});

test('팔로워(leader:false)는 어떤 경우에도 유지하지 않는다', () => {
  assert.equal(holdsLeaseOnWriteFailure({ leader: false, ownedAt: NOW - 1_000 }, NOW), false);
});
