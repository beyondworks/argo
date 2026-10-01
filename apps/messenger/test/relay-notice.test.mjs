// 점검 A·B #9 — 사람끼리 1:1에서 owner가 @에이전트를 부르면 남는 "전달했습니다" 안내(system 글).
// 상대에게는 owner가 쓴 글처럼 보이고, 상대가 누르는 "서윤 대화 열기" 버튼은 그 에이전트 1:1에 권한이 없어 아무 일도 하지 않았다.
// 고른 방법: 글 자체를 감추지 않고(감추면 메시지 목록·안 읽음 셈이 달라진다) 보는 사람에 따라 그리는 방식만 나눈다 —
// 부른 사람(글쓴이)에게는 종전 그대로(문장 + 대화 열기 버튼), 다른 사람에게는 버튼 없이 "○○님이 에이전트를 불렀습니다: 서윤".
import test from 'node:test';
import assert from 'node:assert/strict';
import { relayNoticeView } from '../src/dm-delivery.mjs';
import { t } from '../src/i18n.js';

const notice = { kind: 'system', author_kind: 'user', author_user_id: 'owner', meta: { relay_to: [{ crew_id: 'c1', channel_id: 'ch1', name: '서윤', role: 'to' }] } };

test('글쓴이(부른 사람)에게는 버튼이 있는 종전 안내', () => {
  assert.deepEqual(relayNoticeView(notice, 'owner'), { audience: 'sender' });
});

test('다른 사람에게는 버튼 없는 안내 — 누가 불렀는지 알린다', () => {
  assert.deepEqual(relayNoticeView(notice, 'member'), { audience: 'other' });
});

test('작성자를 알 수 없는 글도 다른 사람 취급(버튼을 보이지 않는다) — 눌러도 안 되는 버튼이 더 나쁘다', () => {
  assert.deepEqual(relayNoticeView({ ...notice, author_user_id: null }, 'owner'), { audience: 'other' });
});

test('상대용 문장은 한국어·영어 모두 있고, 사람 이름과 에이전트 이름이 들어간다', () => {
  assert.equal(t('dm.relay.to.other', 'ko', { who: '유건', names: '서윤' }), '유건님이 에이전트를 불렀습니다: 서윤');
  assert.equal(t('dm.relay.to.other', 'en', { who: '유건', names: '서윤' }), '유건 called an agent: 서윤');
});
