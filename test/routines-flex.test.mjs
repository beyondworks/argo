// 루틴 유연화 회귀 가드 — 복수 요일(dows)·복수 시각(times) 스케줄, 하위호환(단수 필드),
// 슬롯별 isDue 판정, 자연어 초안 검증기(모델 출력 불신 원칙). 전부 순수 함수 — LLM 미개입.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedule, isDue, sanitizeRoutinePatch, validateRoutineDraft } from '../src/routines.mjs';

const at = (h, m, dow = 1) => {
  // 2026-07-20(월)=dow 1 기준 주간 이동 — 로컬 타임존 고정 날짜로 결정적 테스트
  const base = new Date(2026, 6, 19 + dow, h, m, 0, 0); // 7/19=일(0) … 7/25=토(6)
  return base;
};

test('normalizeSchedule: 단수 필드 하위호환 — time/dow가 times/dows로 승격되고 단수도 유지', () => {
  const s = normalizeSchedule({ type: 'weekly', time: '09:00', dow: 3 });
  assert.deepEqual(s.times, ['09:00']);
  assert.deepEqual(s.dows, [3]);
  assert.equal(s.time, '09:00');
  assert.equal(s.dow, 3);
});

test('normalizeSchedule: 복수 시각 중복 제거·정렬 + 잘못된 항목은 통째로 거절', () => {
  const s = normalizeSchedule({ type: 'daily', times: ['18:00', '09:00', '18:00'] });
  assert.deepEqual(s.times, ['09:00', '18:00']);
  assert.equal(s.time, '09:00'); // 단수 필드 = 첫 값(구버전 동기화 호환)
  assert.throws(() => normalizeSchedule({ type: 'daily', times: ['09:00', '9시'] }), /HH:MM/);
  assert.throws(() => normalizeSchedule({ type: 'weekly', times: ['09:00'], dows: [1, 9] }), /요일/);
});

test('sanitizeRoutinePatch: schedule 패치가 normalizeSchedule을 통과한다', () => {
  const out = sanitizeRoutinePatch({ schedule: { type: 'weekly', times: ['10:00', '15:00'], dows: [5, 1] } });
  assert.deepEqual(out.schedule.dows, [1, 5]);
  assert.deepEqual(out.schedule.times, ['10:00', '15:00']);
});

test('isDue: 복수 요일 — 포함된 요일만 발화', () => {
  const r = { enabled: true, created: '2026-07-01T00:00:00.000Z', lastRun: null,
    schedule: { type: 'weekly', times: ['09:00'], dows: [1, 3], time: '09:00', dow: 1 } };
  assert.equal(isDue(r, at(9, 5, 1)), true);  // 월
  assert.equal(isDue(r, at(9, 5, 2)), false); // 화 — 미포함
  assert.equal(isDue(r, at(9, 5, 3)), true);  // 수
});

test('isDue: 하루 복수 시각 — 앞 슬롯 실행이 뒤 슬롯을 막지 않는다', () => {
  const r = { enabled: true, created: '2026-07-01T00:00:00.000Z', lastRun: null,
    schedule: { type: 'daily', times: ['09:00', '18:00'], time: '09:00' } };
  assert.equal(isDue(r, at(8, 50)), false);                 // 첫 슬롯 전
  assert.equal(isDue(r, at(9, 1)), true);                   // 09:00 슬롯 due
  r.lastRun = at(9, 1).toISOString();                       // 선점 마킹(스케줄러 동작 재현)
  assert.equal(isDue(r, at(9, 2)), false);                  // 같은 슬롯 재발화 없음
  assert.equal(isDue(r, at(17, 59)), false);                // 다음 슬롯 전
  assert.equal(isDue(r, at(18, 3)), true);                  // 18:00 슬롯 — lastRun(09:01) < 18:00
});

test('isDue: 생성 이전 슬롯은 놓친 실행이 아니다 — 뒤 슬롯만 발화', () => {
  const created = at(11, 0); // 11:00에 만든 09:00·18:00 루틴
  const r = { enabled: true, created: created.toISOString(), lastRun: null,
    schedule: { type: 'daily', times: ['09:00', '18:00'], time: '09:00' } };
  assert.equal(isDue(r, at(11, 30)), false); // 09:00은 생성 전 — 억제
  assert.equal(isDue(r, at(18, 10)), true);  // 18:00은 정상 발화
});

test('isDue: 기존 단수 스케줄 루틴(구 데이터) 동작 불변', () => {
  const r = { enabled: true, created: '2026-07-01T00:00:00.000Z', lastRun: null,
    schedule: { type: 'weekly', time: '09:00', dow: 1 } };
  assert.equal(isDue(r, at(9, 5, 1)), true);
  assert.equal(isDue(r, at(9, 5, 2)), false);
  assert.equal(isDue(r, at(14, 0, 1)), false); // catch-up 4h 상한
});

test('validateRoutineDraft: 정상 초안 정규화 + 명단 밖 크루는 null', () => {
  const agents = [{ slug: 'pepper', name: '페퍼', role: '마케터' }];
  const { draft } = validateRoutineDraft({
    title: ' 인스타 댓글 정리 ', prompt: ' 댓글 확인하고 정리 ',
    schedule: { type: 'weekly', times: ['09:00', '18:00'], dows: [1, 2, 3, 4, 5] },
    agentSlug: 'ghost',
  }, { agents });
  assert.equal(draft.title, '인스타 댓글 정리');
  assert.deepEqual(draft.schedule.dows, [1, 2, 3, 4, 5]);
  assert.equal(draft.agentSlug, null); // 모델이 지어낸 slug 채택 금지
});

test('validateRoutineDraft: 트리거형 미지원 통과 + 쓰레기 입력 거절', () => {
  const u = validateRoutineDraft({ unsupported: 'trigger', reason: '메일 수신 트리거' }, {});
  assert.equal(u.unsupported, 'trigger');
  assert.throws(() => validateRoutineDraft({ title: '', prompt: '', schedule: {} }, {}), /제목|지시|HH:MM/);
});
