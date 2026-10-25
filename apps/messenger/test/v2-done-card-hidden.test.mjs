// 끝난 일 카드 숨김(2026-10-25 유건 직접 지시 "“00의 일. 끝났습니다.” 이 문구 안 뜨게 해줘") — 메신저 0.1.65 결함 4.
// 정상으로 끝난 일(done)은 채팅에 카드를 남기지 않고, 진행·결재 대기·실패·취소·받은 에이전트 없음·결과 모름은 남긴다.
// 방을 다시 열거나 새로고침하면 loadWorks가 같은 행을 다시 주므로, 그리는 쪽(useWorkCards의 cards)이 매번 같은 판정을 거친다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workCard, shownInChat } from '../src/v2/work-card.mjs';

const NOW = Date.parse('2026-10-25T04:00:00Z');
const row = (state, extra = {}) => ({
  id: `w-${state}`, agent_id: 'a1', topic_id: 't1', state, owner_user_id: 'u1', root_user_id: 'u1',
  expires_at: new Date(NOW + 600_000).toISOString(), lease_until: new Date(NOW + 600_000).toISOString(), created_at: new Date(NOW - 1_000).toISOString(), ...extra,
});

test('done 카드는 채팅에 남지 않는다', () => {
  const card = workCard({ work: row('done', { has_result: true }), uid: 'u1', now: NOW });
  assert.equal(card.phase, 'done');
  assert.equal(shownInChat(card), false);
});

test('진행·결재 대기·실패·취소·받은 에이전트 없음 카드는 그대로 남는다', () => {
  for (const state of ['offered', 'accepted', 'running', 'awaiting_approval', 'failed', 'cancelled']) {
    const card = workCard({ work: row(state), uid: 'u1', now: NOW });
    assert.equal(shownInChat(card), true, state);
  }
  const expired = workCard({ work: row('offered', { expires_at: new Date(NOW - 1).toISOString() }), uid: 'u1', now: NOW });
  assert.equal(expired.phase, 'expired'); assert.equal(shownInChat(expired), true, '받은 에이전트 없음');
});

test('결재를 거쳐 끝난 일도(승인 도장 있음) 남지 않는다 — 다시 읽어도 같다', () => {
  const ap = { id: 'p1', state: 'approved', action: '메일 발송', risk: 'high', expires_at: new Date(NOW + 60_000).toISOString(), created_at: new Date(NOW).toISOString() };
  for (let i = 0; i < 2; i += 1) assert.equal(shownInChat(workCard({ work: row('done'), approval: ap, uid: 'u1', now: NOW })), false);
});

test('배선: 채팅의 일 카드 목록(before·after·rest·결재 탭)은 shownInChat을 거친다', () => {
  const src = readFileSync(new URL('../src/v2/useWorkCards.jsx', import.meta.url), 'utf8');
  assert.match(src, /import \{ workCard, stalledGuard, shownInChat \} from '\.\/work-card\.mjs';/);
  assert.match(src, /\.filter\(\(c\) => shownInChat\(c\.card\)\)[^\n]*\n\s*\.sort\(/, 'cards를 만드는 자리에서 거른다 — before·after·rest·approvalRows가 모두 cards를 쓴다');
});
