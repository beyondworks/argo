// once '만료' 판정 — "한 번도 발화하지 못한 once" 좀비의 표시 처방(PR #354 검수 3R 잔존 집합).
//
// 예약 시각이 앱이 꺼진 사이 지나가 isDue의 catch-up 창(4h)까지 놓치면 enabled:true인 채 영영
// 발화하지 않고 목록에 '가동'으로 남았다. onceExpired는 그런 루틴만 만료로 판정한다 — 표시 전용
// 파생 판정(상태 쓰기 없음): 자동 비활성은 판정 오염 시 되돌릴 수 없고 쓰기 주체·다기기 동기화
// 표면을 새로 만들어 기각("소비 안 된 슬롯을 끄면 안 된다" MEDIUM-1 계보의 보수 원칙).
//
// 핵심 불변식: **만료 ⟹ isDue가 더는 참일 수 없다** — catch-up 창 안(발화 가능)에서 '만료'라
// 표시하면 거짓이고, 삭제를 유도해 산 예약을 잃게 만든다. 아래에서 경계 양쪽을 isDue와 짝지어
// 잠근다. 판정은 전부 명시 now 주입이라 실 시계와 무관하게 결정적이다(스케줄 tz 미지정 = 기기
// 로컬 — tz 갈래는 routine-timezone.test.mjs의 onceSpent/zonedParts 커버를 공유).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onceExpired, onceSpent, CATCHUP_MS } from '../src/routine-time.mjs';

const sched = { type: 'once', date: '2026-06-15', time: '09:00', times: ['09:00'] };
const R = (over = {}) => ({ enabled: true, schedule: sched, lastRun: null, ...over });
const at = (h, m, s = 0, day = 15) => new Date(2026, 5, day, h, m, s); // 로컬 2026-06-{day}

test('만료 경계: catch-up 창(4h) 안은 만료가 아니다 — 앱이 켜지면 곧 발화한다', () => {
  assert.equal(onceExpired(R(), at(8, 0)), false, '슬롯 전 — 살아 있는 예약');
  assert.equal(onceExpired(R(), at(10, 0)), false, '슬롯+1h — catch-up이 발화할 수 있다');
  assert.equal(onceExpired(R(), at(12, 59, 30)), false, '창 닫히기 직전까지 만료 아님');
  assert.equal(onceExpired(R(), at(13, 0, 30)), true, '창(슬롯+4h)이 닫히면 만료');
  assert.equal(onceExpired(R(), at(9, 0, 0, 16)), true, '다음 날 — 만료');
});

test('만료 ⟹ isDue 불가(핵심 불변식) — 경계 양쪽을 isDue와 짝지어 확인', async () => {
  // isDue는 routines.mjs 소속(노드 의존) — 임시 ARGO_ROOT로 격리해 임포트만 한다
  process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-expired-'));
  const { isDue } = await import('../src/routines.mjs');
  const live = R({ created: at(8, 0, 0, 14).toISOString() }); // 전날 생성 — 신규 루틴 스킵 규칙 밖
  assert.equal(isDue(live, at(12, 59, 30)), true, '전제: 창 안에서는 실제로 발화 가능하다');
  assert.equal(onceExpired(live, at(12, 59, 30)), false, '발화 가능한 동안 만료라 표시하면 거짓');
  assert.equal(isDue(live, at(13, 0, 30)), false, '전제: 창이 닫히면 isDue도 불가');
  assert.equal(onceExpired(live, at(13, 0, 30)), true, 'isDue가 불가능해진 뒤에만 만료');
});

test('lastRun 판정: 슬롯 이전 시험 실행은 만료, 슬롯 이후 발화 기록은 실행됨(만료 아님)', () => {
  const dayAfter = at(9, 0, 0, 16);
  assert.equal(onceExpired(R({ lastRun: at(8, 0).toISOString() }), dayAfter), true,
    '슬롯 전 lastRun(미리 시험)은 슬롯을 소비하지 않았다 — #354 MEDIUM-1과 같은 판정 시계');
  assert.equal(onceExpired(R({ lastRun: at(9, 0, 30).toISOString() }), dayAfter), false,
    '슬롯 이후 lastRun(발화·선점 기록)은 실행된 것 — 만료로 표시하면 이중 서사');
});

test('만료는 켜진 once에만 — 꺼짐·반복 루틴은 각자의 상태를 유지한다 (인접 행동 핀)', () => {
  const dayAfter = at(9, 0, 0, 16);
  assert.equal(onceExpired(R({ enabled: false }), dayAfter), false, '꺼진 루틴은 꺼짐 표시가 맞다');
  assert.equal(onceExpired({ enabled: true, schedule: { type: 'daily', times: ['09:00'] }, lastRun: null }, dayAfter), false, 'daily는 내일 또 돈다');
  assert.equal(onceExpired({ enabled: true, schedule: { type: 'interval', everyMinutes: 30 }, lastRun: null }, dayAfter), false, 'interval은 만료 개념이 없다');
  assert.equal(onceExpired(null, dayAfter), false, '빈 입력 방어');
});

test('재수출 배선: routines.mjs 경유 임포트가 같은 함수다 — 원천 이원화 금지', async () => {
  process.env.ARGO_ROOT ??= await mkdtemp(join(tmpdir(), 'argo-expired-'));
  const viaRoutines = await import('../src/routines.mjs');
  assert.equal(viaRoutines.onceSpent, onceSpent, '기존 소비자(테스트·catch 게이트)가 쓰는 onceSpent가 같은 원천이어야 한다');
  assert.equal(viaRoutines.onceExpired, onceExpired);
});

test('창 상수 정합: 만료 경계는 isDue의 catch-up 상한과 같은 값이다', () => {
  assert.equal(CATCHUP_MS, 4 * 60 * 60 * 1000, '값이 갈리면 만료 표시와 실제 발화 가능성이 어긋난다');
});

test('알려진 한계(DST 되돌림): 반복 시각대 슬롯은 한때 만료·발화가능이 겹친다 (실행 문서 — #364 검수 실측)', async () => {
  // 뿌리는 이 판정이 아니라 isDue의 문서화된 되돌림 결함(벽시계 역산으로 창이 실질 연장)이다.
  // 표시 전용이라 산 예약이 취소되진 않지만 그동안 툴팁이 삭제를 권한다 — 연 1일 × DST 시간대 ×
  // 반복 시각대 × once 한정. 이 단언이 red가 되면(특히 expired가 false로) isDue의 DST 결함이
  // 고쳐졌을 가능성이 크다 — routine-time.mjs의 한계 서술과 이 핀을 함께 갱신할 것.
  process.env.ARGO_ROOT ??= await mkdtemp(join(tmpdir(), 'argo-expired-'));
  const { isDue } = await import('../src/routines.mjs');
  const r = { enabled: true, created: '2026-10-01T00:00:00.000Z', lastRun: null,
    schedule: { type: 'once', date: '2026-11-01', time: '01:30', times: ['01:30'], tz: 'America/New_York' } };
  const before = new Date('2026-11-01T09:00:00Z'); // NY 되돌림 뒤 04:00 EST — 아직 창 산술이 겹치기 전
  assert.equal(isDue(r, before), true, '전제: 되돌림 결함으로 창이 연장돼 발화 가능');
  assert.equal(onceExpired(r, before), false, '겹침 구간 밖에서는 만료가 아니다');
  const inWindow = new Date('2026-11-01T09:30:00Z'); // NY 04:30 EST — 실측 위반 구간 내부
  assert.equal(isDue(r, inWindow), true, '전제: 여전히 발화 가능(isDue 결함의 연장 창)');
  assert.equal(onceExpired(r, inWindow), true, '알려진 한계: 발화 가능인데 만료로 표시되는 구간이 실재한다');
});
