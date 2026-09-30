// 거래처 메일 만족도 신호(유건 9/29) — AI 없이 신호 4개: 상대 회신, 내 첫 회신 시간, 감사·긍정, 불만·재촉 → 좋음/보통/주의 + 근거 메일.
// 본문은 저장하지 않는다 — Gmail 앞부분 요약(snippet)만 이 자리에서 보고 버린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { customerMatcher, threadSignals, gmailQuery, gradeOf } from '../server/mail-signals.js';

const H = 3600e3, T0 = Date.parse('2026-09-10T01:00:00Z');
const customers = [{ id: 'c1', email: 'kim@hanbit.co.kr' }, { id: 'c2', email: 'lee@gmail.com' }, { id: 'c3', email: '' }];
const match = customerMatcher(customers);
const msg = (id, from, at, snippet = '', to = '') => ({ id, from, to, at: new Date(at).toISOString(), snippet });

test('거래처 판별: 이메일이 같거나 공용 메일이 아닌 같은 회사 도메인', () => {
  assert.equal(match('kim@hanbit.co.kr'), 'c1');
  assert.equal(match('park@hanbit.co.kr'), 'c1');       // 같은 회사 다른 담당자
  assert.equal(match('lee@gmail.com'), 'c2');
  assert.equal(match('other@gmail.com'), null);         // 공용 메일 도메인은 주소가 같아야
  assert.equal(match('x@unknown.com'), null);
});

test('검색어: 거래처 주소·도메인으로 최근 N일', () => {
  assert.equal(gmailQuery(customers, 30), 'newer_than:30d {from:@hanbit.co.kr to:@hanbit.co.kr from:lee@gmail.com to:lee@gmail.com}');
  assert.equal(gmailQuery([], 30), null);
});

test('감사 표현 + 내가 하루 안에 답함 → 좋음', () => {
  const s = threadSignals('t1', [msg('m1', 'kim@hanbit.co.kr', T0, '견적 부탁드립니다'), msg('m2', 'me@beyond.kr', T0 + 3 * H), msg('m3', 'kim@hanbit.co.kr', T0 + 20 * H, '빠른 처리 감사합니다')], 'me@beyond.kr', match, T0 + 30 * H);
  assert.equal(s.customer_id, 'c1'); assert.equal(s.grade, 'good');
  assert.deepEqual(s.reasons.sort(), ['quick_reply', 'replied', 'thanks']);
  assert.equal(s.reply_minutes, 180); assert.equal(s.last_message_id, 'm3'); assert.equal(s.day, '2026-09-11'); // 마지막 메일 UTC 21시 = 한국 다음 날 새벽
});

test('재촉 표현 → 주의(마지막 거래처 메일 기준)', () => {
  const s = threadSignals('t2', [msg('m1', 'me@beyond.kr', T0), msg('m2', 'kim@hanbit.co.kr', T0 + 50 * H, '아직 답변이 없네요')], 'me@beyond.kr', match, T0 + 51 * H);
  assert.equal(s.grade, 'caution'); assert.ok(s.reasons.includes('pushy'));
});

test('거래처 메일에 내가 3일(72시간) 넘게 답하지 않음 → 주의, 72시간 전이면 아직 아니다', () => {
  const t = [msg('m1', 'kim@hanbit.co.kr', T0, '계약서 검토 부탁드립니다')];
  assert.equal(threadSignals('t3', t, 'me@beyond.kr', match, T0 + 71 * H).grade, 'normal');
  const late = threadSignals('t3', t, 'me@beyond.kr', match, T0 + 73 * H);
  assert.equal(late.grade, 'caution'); assert.ok(late.reasons.includes('late_reply'));
});

test('내가 보낸 메일에 상대가 5일째 회신 없음 → 기록만(보통), 거래처가 없는 스레드는 뺀다', () => {
  const s = threadSignals('t4', [msg('m1', 'me@beyond.kr', T0, '', 'Kim <kim@hanbit.co.kr>')], 'me@beyond.kr', match, T0 + 6 * 24 * H);
  assert.equal(s.grade, 'normal'); assert.deepEqual(s.reasons, ['no_reply']);
  assert.equal(threadSignals('t5', [msg('m1', 'x@unknown.com', T0)], 'me@beyond.kr', match, T0 + H), null);
});

test('판정 규칙은 근거 종류에서만 나온다(DB도 같은 규칙으로 다시 계산한다)', () => {
  assert.equal(gradeOf(['thanks', 'pushy']), 'caution');
  assert.equal(gradeOf(['replied', 'quick_reply']), 'good');
  assert.equal(gradeOf(['replied']), 'normal');
});

// 분리 검수 MEDIUM: 형식이 틀린 거래처 이메일(공백·중괄호·OR)이 Gmail 검색어에 섞여 범위를 넓히면 안 된다
test('검색어·판별: 이메일 형식이 아니면 넣지 않는다', () => {
  const bad = [{ id: 'x', email: 'x@evil domain} OR {from:boss@ourcompany.com' }, { id: 'y', email: 'a b@c.com' }, { id: 'ok', email: 'kim@hanbit.co.kr' }];
  assert.equal(gmailQuery(bad, 30), 'newer_than:30d {from:@hanbit.co.kr to:@hanbit.co.kr}');
  assert.equal(customerMatcher(bad)('boss@ourcompany.com'), null);
});
