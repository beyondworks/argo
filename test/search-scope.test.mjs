// UX-A03(2026-10-05): 상단 검색이 데크·활동·기억 밖에서는 입력해도 아무 반응이 없었다 — 받는 화면에서만 보인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchScope } from '../app/c/[ws]/search-scope.mjs';

test('검색을 받는 화면만 대상 — 나머지는 칸을 숨긴다', () => {
  assert.equal(searchScope('/c/acme', 'acme'), 'deck');
  assert.equal(searchScope('/c/acme/', 'acme'), 'deck');
  assert.equal(searchScope('/c/acme/activity', 'acme'), 'activity');
  assert.equal(searchScope('/c/acme/vault', 'acme'), 'vault');
  for (const p of ['/c/acme/crew/pepper', '/c/acme/room', '/c/acme/compete', '/c/acme/routines', '/c/acme/mail', '/c/acme/market', '/c/acme/settings']) {
    assert.equal(searchScope(p, 'acme'), null, p);
  }
});

// UL10(2026-10-05): 위 소스 문자열 단언(addEventListener 글자 찾기)은 구독 이름·정규화가 어긋나도 초록이다. 이벤트 이름·질의 정규화를 search-bus.mjs 한 곳으로 모으고
// 레이아웃(emit)과 세 화면(subscribe)이 같은 모듈을 지나게 한 뒤, 그 전달을 EventTarget으로 행동 검증한다.
import { emitSearch, subscribeSearch, SEARCH_EVENT } from '../app/c/[ws]/search-bus.mjs';

test('상단 검색 → 받는 화면: 레이아웃이 보낸 질의가 구독자에게 소문자로 전달되고, 해제하면 더 오지 않는다', () => {
  const bus = new EventTarget(); // window 대역
  const got = [];
  const stop = subscribeSearch(bus, (q) => got.push(q));
  emitSearch(bus, 'Pepper');
  emitSearch(bus, '');
  emitSearch(bus, undefined);
  emitSearch(bus, '개발자 PEPPER');
  assert.deepEqual(got, ['pepper', '', '', '개발자 pepper'], '정규화: 소문자·빈 값은 ""');
  stop();
  emitSearch(bus, 'after');
  assert.deepEqual(got, ['pepper', '', '', '개발자 pepper'], '해제한 뒤에는 전달되지 않는다');
});

test('이벤트 이름이 한 곳 — 두 구독자가 같은 질의를 받고, 다른 이름의 이벤트는 받지 않는다', () => {
  const bus = new EventTarget();
  const a = []; const b = [];
  subscribeSearch(bus, (q) => a.push(q)); subscribeSearch(bus, (q) => b.push(q));
  bus.dispatchEvent(new CustomEvent('argo:other', { detail: 'x' }));
  emitSearch(bus, 'Q');
  assert.deepEqual([a, b], [['q'], ['q']]);
  assert.equal(SEARCH_EVENT, 'argo:search', '화면 밖 소비자(데스크톱 셸 등)가 쓰는 이름은 그대로');
});

test('배선 핀 — 검색을 받는 세 화면과 레이아웃이 모두 이 모듈을 지난다(이름이 다시 흩어지지 않게)', () => {
  for (const f of ['app/c/[ws]/page.jsx', 'app/c/[ws]/activity/page.jsx', 'app/c/[ws]/vault/page.jsx']) {
    assert.match(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /import \{ subscribeSearch \} from '[./]*search-bus\.mjs'/, f);
  }
  assert.match(readFileSync(new URL('../app/c/[ws]/layout.jsx', import.meta.url), 'utf8'), /import \{ emitSearch \} from '\.\/search-bus\.mjs'/);
  for (const f of ['app/c/[ws]/page.jsx', 'app/c/[ws]/activity/page.jsx', 'app/c/[ws]/vault/page.jsx', 'app/c/[ws]/layout.jsx']) {
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /['"]argo:search['"]/, `${f}: 이름을 직접 쓰지 않는다`);
  }
});
