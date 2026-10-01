// 점검 A·B #12 — 같은 이름의 에이전트가 둘이면 목록에서 구별할 수 없던 결함("유건의 오픈클로"가 두 줄).
// 같은 이름이 있을 때만 이미 데이터에 있는 정보(종류·만든 날, 같은 날이면 시각)를 덧붙인다. 이름이 겹치지 않으면 목록은 그대로.
import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateNameHints } from '../src/crew-hints.mjs';

const at = (d, h = 13, mi = 0) => new Date(2026, 9, d, h, mi).toISOString(); // 로컬 시각 — 표시도 로컬 기준
const kindOf = (c) => ({ openclaw: '오픈클로', hermes: '헤르메스' }[c.kind] ?? '아르고');
const hints = (crews, lang = 'ko') => duplicateNameHints(crews, { lang, sourceLabel: kindOf });

test('이름이 겹치지 않으면 아무 것도 덧붙이지 않는다', () => {
  assert.deepEqual([...hints([{ id: 'a', display_name: '서윤', kind: 'argo', created_at: at(1) }, { id: 'b', display_name: '준', kind: 'argo', created_at: at(1) }])], []);
});

test('같은 이름 둘 — 종류와 만든 날을 덧붙인다(겹친 이름에만)', () => {
  const h = hints([
    { id: 'a', display_name: '내 봇', kind: 'openclaw', created_at: at(1) },
    { id: 'b', display_name: '내 봇', kind: 'openclaw', created_at: at(2) },
    { id: 'c', display_name: '서윤', kind: 'argo', created_at: at(1) },
  ]);
  assert.equal(h.get('a'), '오픈클로 · 10월 1일');
  assert.equal(h.get('b'), '오픈클로 · 10월 2일');
  assert.equal(h.has('c'), false);
});

test('같은 날 만든 같은 이름이면 시각까지', () => {
  const h = hints([
    { id: 'a', display_name: '봇', kind: 'openclaw', created_at: at(1, 9, 5) },
    { id: 'b', display_name: '봇', kind: 'openclaw', created_at: at(1, 13, 2) },
  ]);
  assert.equal(h.get('a'), '오픈클로 · 10월 1일 09:05');
  assert.equal(h.get('b'), '오픈클로 · 10월 1일 13:02');
});

test('종류가 다르면 종류가 구별해 주고, 영어 날짜 표기', () => {
  const h = hints([
    { id: 'a', display_name: 'Bot', kind: 'hermes', created_at: at(1) },
    { id: 'b', display_name: 'Bot', kind: 'openclaw', created_at: at(1) },
  ], 'en');
  assert.equal(h.get('a'), '헤르메스 · Oct 1');
  assert.equal(h.get('b'), '오픈클로 · Oct 1');
});

test('이름 비교는 대소문자·앞뒤 공백을 무시한다', () => {
  const h = hints([
    { id: 'a', display_name: 'Seoyun ', kind: 'argo', created_at: at(1) },
    { id: 'b', display_name: 'seoyun', kind: 'argo', created_at: at(2) },
  ]);
  assert.equal(h.size, 2);
});

test('분까지 같으면 만든 순서 번호로 끝까지 구별한다', () => {
  const h = hints([
    { id: 'a', display_name: '봇', kind: 'argo', created_at: at(1, 13, 2) },
    { id: 'b', display_name: '봇', kind: 'argo', created_at: at(1, 13, 2) },
  ]);
  assert.notEqual(h.get('a'), h.get('b'));
});

test('만든 날을 모르면(데이터 없음) 종류만 — 빈 괄호·undefined 없이', () => {
  const h = hints([{ id: 'a', display_name: '봇', kind: 'openclaw' }, { id: 'b', display_name: '봇', kind: 'hermes' }]);
  assert.equal(h.get('a'), '오픈클로'); assert.equal(h.get('b'), '헤르메스');
});

test('이름에 종류가 이미 들어 있으면 종류는 되풀이하지 않는다("유건의 오픈클로 · 오픈클로" 방지)', () => {
  const h = hints([
    { id: 'a', display_name: '유건의 오픈클로', kind: 'openclaw', created_at: at(1) },
    { id: 'b', display_name: '유건의 오픈클로', kind: 'openclaw', created_at: at(2) },
  ]);
  assert.equal(h.get('a'), '10월 1일'); assert.equal(h.get('b'), '10월 2일');
});
