// 직접 입력한 "@이름"(목록에서 고르지 않음)도 보낼 때 멘션으로 — 방의 크루·사람 이름과 정확히(대소문자 무시) 같은 토큰만.
// 붙은 한국어 조사·호칭(님·씨·아·야·은·는·이·가·을·를·에게·한테)은 떼고 비교한다. 이메일은 멘션이 아니다.
// 같은 이름이 둘 이상이면 아무도 고르지 않고 보내기를 멈춘다(입력창 아래 안내). 방 밖 크루면 기존 방 밖 안내(#826).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsFromBody, outsideCrewMentions, ambiguousMentions } from '../src/mention-candidates.mjs';

const PEPPER = { kind: 'crew', id: 'c-pepper', name: '페퍼' };
const EDNA = { kind: 'crew', id: 'c-edna', name: 'Edna' };
const YOO = { kind: 'user', id: 'u-yoo', name: '유건' };
const room = [PEPPER, EDNA, YOO];
const ids = (body, cands = room, picked = []) => mentionsFromBody(body, cands, picked).map((x) => x.id);

test('정확히 같은 이름 토큰 — 띄어쓰기·문장부호 경계, 대소문자 무시(기존 규칙 유지)', () => {
  assert.deepEqual(ids('@페퍼 테스트'), ['c-pepper']);
  assert.deepEqual(ids('@페퍼, 이거 봐 줘'), ['c-pepper']);
  assert.deepEqual(ids('@edna hi'), ['c-edna']);
  assert.deepEqual(ids('@페퍼퍼 테스트'), [], '이름 뒤에 다른 글자가 붙으면 다른 이름');
  assert.deepEqual(ids('@페 테스트'), [], '이름 일부');
});

test('붙은 조사·호칭은 떼고 비교한다', () => {
  for (const tail of ['님', '씨', '아', '야', '은', '는', '이', '가', '을', '를', '에게', '한테', '님은', '님한테']) {
    assert.deepEqual(ids(`@페퍼${tail} 이거 해 줘`), ['c-pepper'], `@페퍼${tail}`);
  }
  assert.deepEqual(ids('@EDNA야 hi'), ['c-edna']);
  assert.deepEqual(ids('@유건님 확인 부탁'), ['u-yoo']);
  assert.deepEqual(ids('@페퍼님.'), ['c-pepper'], '조사 뒤 문장부호');
  assert.deepEqual(ids('@페퍼이다'), [], '조사처럼 시작해도 뒤에 글자가 이어지면 아니다');
});

test('이메일·단어 안의 @는 멘션이 아니다', () => {
  const cands = [{ kind: 'crew', id: 'c-p', name: 'pepper' }];
  assert.deepEqual(ids('메일은 yoo@pepper.com 으로', cands), []);
  assert.deepEqual(ids('a@페퍼 테스트'), []);
});

test('같은 이름이 둘 이상 — 목록에서 고르지 않았으면 모호한 이름으로 알린다', () => {
  const twin = { kind: 'user', id: 'u-pepper', name: '페퍼' };
  const cands = [...room, twin];
  assert.deepEqual(ambiguousMentions('@페퍼 테스트', cands), ['페퍼']);
  assert.deepEqual(ambiguousMentions('@페퍼님 테스트', cands), ['페퍼'], '조사가 붙어도');
  assert.deepEqual(ambiguousMentions('@페퍼 테스트', cands, [PEPPER]), [], '목록에서 고른 것이 있으면 모호하지 않다');
  assert.deepEqual(ambiguousMentions('@Edna 테스트', cands), [], '이름이 하나뿐');
  assert.deepEqual(ambiguousMentions('그냥 글', cands), []);
  assert.deepEqual(ambiguousMentions('@all 모두', cands), [], '@all은 모두라 모호하지 않다');
  const caseTwin = [...room, { kind: 'crew', id: 'c-edna2', name: 'EDNA' }];
  assert.deepEqual(ambiguousMentions('@edna hi', caseTwin), ['Edna'], '대소문자만 다른 이름도 같은 이름');
  const longer = [...cands, { kind: 'crew', id: 'c-pv', name: '페퍼 (VPS)' }];
  assert.deepEqual(ambiguousMentions('@페퍼 (VPS) 봐 줘', longer), [], '긴 이름이 먼저 맞으면 짧은 동명이인은 따지지 않는다');
});

test('방 밖 크루 — 조사가 붙어도 방 밖 안내 대상으로 잡는다(#826 흐름)', () => {
  const org = [{ id: 'c-pepper', display_name: '페퍼', owner_user_id: 'u-yoo' }, { id: 'c-beast', display_name: '비스트', owner_user_id: 'u-yoo' }];
  assert.deepEqual(outsideCrewMentions('@비스트님 이거', [EDNA, YOO], org, 'u-yoo').map((c) => c.id), ['c-beast']);
  assert.deepEqual(outsideCrewMentions('@페퍼 테스트', [EDNA, YOO], org, 'u-yoo').map((c) => c.id), ['c-pepper'], '10:58:48 실측 — 방 밖 페퍼');
  assert.deepEqual(outsideCrewMentions('@페퍼에게', room, org, 'u-yoo'), [], '방 안이면 방 밖 안내가 아니다');
});
