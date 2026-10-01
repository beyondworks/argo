import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV, readNav, writeNav, moveId, readFav, writeFav, FAV_MAX, routeInfo, favTarget, favable, routeLabelKey, routeIcon, VIEWS, NAV_ICON } from '../src/core/nav-model.js';

// 이유(유건 9/30): "좌측 패널 메뉴가 하드코딩이면 모듈식이 아니다" — 사람마다 순서를 바꾸고 숨긴다(기기가 바뀌어도 같게 DB).
// 홈은 숨길 수 없고, 설정·휴지통은 아래 고정 칸이라 목록에 없다. 메뉴·페이지(위키)·에이전트 세 칸의 순서도 바꾼다.
test('저장값이 없으면 공간별 기본 메뉴 순서, 세 칸은 메뉴 → 페이지 → 에이전트', () => {
  const me = readNav([], 'me'), org = readNav([], 'org');
  assert.deepEqual(me.shown, NAV.me);
  assert.deepEqual(org.shown, NAV.org);
  assert.deepEqual(me.sections, ['menu', 'pages', 'crews']);
  assert.deepEqual(me.hidden, []);
});

test('순서·숨김은 한 목록으로 저장하고, 그 공간에 없는 메뉴는 건너뛴다(내 공간의 메일은 조직에 안 보임)', () => {
  let items = writeNav(readNav([], 'org'), { move: ['perf', 'home'] }); // 성과 기록을 맨 위로
  assert.deepEqual(readNav(items, 'org').shown.slice(0, 3), ['perf', 'home', 'calendar']);
  items = writeNav(readNav(items, 'org'), { hide: 'outputs' });
  assert.deepEqual(readNav(items, 'org').hidden, ['outputs']);
  assert.ok(!readNav(items, 'org').shown.includes('outputs'));
  assert.deepEqual(readNav(items, 'me').shown, NAV.me); // 내 공간 목록에는 영향 없음(성과 기록·산출물이 없다)
  items = writeNav(readNav(items, 'org'), { show: 'outputs' });
  assert.ok(readNav(items, 'org').shown.includes('outputs'));
});

// 이유(유건 9/30 일정 명세): 좌측 메뉴 '일정'은 개인·조직 모두 홈 바로 다음
test('일정 메뉴는 두 공간 모두 홈 바로 다음', () => {
  assert.deepEqual(NAV.me.slice(0, 2), ['home', 'calendar']);
  assert.deepEqual(NAV.org.slice(0, 2), ['home', 'calendar']);
  assert.deepEqual(readNav([], 'me').shown.slice(0, 2), ['home', 'calendar']);
});

test('홈은 숨길 수 없고, 모르는 id·중복은 버린다', () => {
  const items = writeNav(readNav([{ id: 'home', hidden: true }, { id: 'zzz' }, { id: 'perf' }, { id: 'perf' }], 'org'), { hide: 'home' });
  const r = readNav(items, 'org');
  assert.ok(r.shown.includes('home'));
  assert.deepEqual(r.shown.filter((x) => x === 'perf').length, 1);
  assert.ok(!items.some((x) => x.id === 'zzz'));
});

test('칸 순서: 에이전트 칸을 맨 위로', () => {
  const items = writeNav(readNav([], 'org'), { section: ['crews', 'menu'] });
  assert.deepEqual(readNav(items, 'org').sections, ['crews', 'menu', 'pages']);
});

test('moveId: a를 b 자리로, 같은 자리·없는 id면 그대로', () => {
  assert.deepEqual(moveId(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(moveId(['a', 'b'], 'a', 'x'), ['a', 'b']);
});

// 이유(9/30 일정 추가): 메뉴 순서를 저장해 둔 사람에게 새 메뉴가 맨 아래로 붙으면 못 찾는다 — 기본 자리(앞 메뉴 바로 뒤)에 들어가야 한다.
test('메뉴: 저장한 뒤 새로 생긴 메뉴는 기본 순서의 앞 메뉴 바로 뒤에 들어간다, 저장 순서는 그대로', () => {
  const saved = ['home', 'tools', 'business', 'mail', 'approvals', 'shared', 'knowhow'].map((id) => ({ id }));
  assert.deepEqual(readNav(saved, 'me').shown, ['home', 'calendar', 'tools', 'business', 'mail', 'approvals', 'shared', 'knowhow']);
  assert.deepEqual(readNav([{ id: 'tools' }, { id: 'home' }], 'me').shown.slice(0, 3), ['tools', 'home', 'calendar'], '앞 메뉴를 옮겨 뒀으면 그 뒤를 따라간다');
});

// 이유(유건 9/30 #7): 즐겨찾기는 사람마다 계정에 저장 — 지워지거나(휴지통) 권한이 사라진 항목은 조용히 숨기고, 다음 저장 때 저장값에서도 뺀다.
test('즐겨찾기: 살아 있는 항목만 저장 순서대로, 모르는 종류·중복은 버린다', () => {
  const alive = (x) => x.id !== 'gone';
  const items = [{ kind: 'page', id: 'p1' }, { kind: 'crew', id: 'c1' }, { kind: 'page', id: 'gone' }, { kind: 'page', id: 'p1' }, { kind: 'mail', id: 'm1' }, null, { kind: 'page' }];
  assert.deepEqual(readFav(items, alive), [{ kind: 'page', id: 'p1' }, { kind: 'crew', id: 'c1' }]);
  assert.deepEqual(readFav(undefined, alive), []);
});

test('즐겨찾기 쓰기: 추가는 맨 뒤·중복 없음, 제거, 끌어 옮기기 — 숨겨진 항목은 저장값에서 빠진다', () => {
  const alive = (x) => x.id !== 'gone';
  const shown = readFav([{ kind: 'page', id: 'p1' }, { kind: 'page', id: 'gone' }, { kind: 'crew', id: 'c1' }], alive);
  let next = writeFav(shown, { add: { kind: 'page', id: 'p2' } });
  assert.deepEqual(next, [{ kind: 'page', id: 'p1' }, { kind: 'crew', id: 'c1' }, { kind: 'page', id: 'p2' }]);
  assert.deepEqual(writeFav(next, { add: { kind: 'page', id: 'p1' } }), next);
  next = writeFav(next, { move: ['page:p2', 'page:p1'] });
  assert.deepEqual(next.map((x) => x.id), ['p2', 'p1', 'c1']);
  assert.deepEqual(writeFav(next, { remove: 'crew:c1' }).map((x) => x.id), ['p2', 'p1']);
});

test('즐겨찾기는 FAV_MAX개까지(한 행 16KB 한도) — 넘치면 추가하지 않는다', () => {
  const full = Array.from({ length: FAV_MAX }, (_, i) => ({ kind: 'page', id: `p${i}` }));
  assert.equal(writeFav(full, { add: { kind: 'page', id: 'extra' } }).length, FAV_MAX);
  assert.ok(JSON.stringify({ items: full.map((x) => ({ ...x, id: '00000000-0000-0000-0000-000000000000' })) }).length < 16384);
});

// 이유(유건 10/1 "좌측 패널에 즐겨찾는 페이지"): 위키 페이지가 없는 조직도 일정·업무 탭·결재함 같은 화면을 즐겨찾기에 넣는다.
// 위키 페이지는 원래 종류('page')로, 그 밖의 화면은 주소('route')로 — 이름은 저장하지 않고 메뉴 사전으로 만든다.
test('즐겨찾기 대상: 페이지는 page, 화면은 route, 메일 한 통·모르는 주소는 없음', () => {
  assert.deepEqual(favTarget('/o/lean-ax/p/abc'), { kind: 'page', id: 'abc' });
  assert.deepEqual(favTarget('/me/p/abc'), { kind: 'page', id: 'abc' });
  assert.deepEqual(favTarget('/o/lean-ax/calendar'), { kind: 'route', id: '/o/lean-ax/calendar' });
  assert.deepEqual(favTarget('/o/lean-ax/business/customers'), { kind: 'route', id: '/o/lean-ax/business/customers' });
  for (const bad of ['/me/mail/m1', '/o/x/business/nope', '/o/x/zzz', '/s/abc', '/', '', undefined]) assert.equal(favTarget(bad), null, String(bad));
});

test('화면 즐겨찾기 이름·아이콘: 메뉴 사전과 업무 탭 사전, 모듈 보관함', () => {
  assert.deepEqual(routeInfo('/o/lean-ax/business/customers'), { space: 'lean-ax', view: 'business', tab: 'customers' });
  assert.equal(routeLabelKey(routeInfo('/o/lean-ax/business/customers')), 'bizui.customers');
  assert.equal(routeLabelKey(routeInfo('/o/lean-ax/business/library')), 'library.title');
  assert.equal(routeLabelKey(routeInfo('/me/approvals')), 'nav.approvals');
  assert.equal(routeLabelKey(routeInfo('/me')), 'nav.home');
  assert.equal(routeInfo('/me/calendar').space, 'me');
  for (const v of VIEWS) assert.ok(NAV_ICON[v] && routeIcon(routeInfo(`/me/${v}`)), v);
  assert.equal(routeIcon(routeInfo('/me/business/customers')), 'person');
});

test('즐겨찾기 읽기: route는 모양이 맞는 주소만 — 페이지·에이전트와 한 목록, 끌어 옮기기도 같은 키', () => {
  const items = [{ kind: 'route', id: '/o/a/calendar' }, { kind: 'route', id: '/o/a/nope' }, { kind: 'route', id: 'javascript:alert(1)' }, { kind: 'page', id: 'p1' }, { kind: 'route', id: '/o/a/calendar' }];
  const shown = readFav(items, () => true);
  assert.deepEqual(shown, [{ kind: 'route', id: '/o/a/calendar' }, { kind: 'page', id: 'p1' }]);
  assert.deepEqual(writeFav(shown, { move: ['page:p1', 'route:/o/a/calendar'] }).map((x) => x.kind), ['page', 'route']);
  assert.deepEqual(writeFav(shown, { remove: 'route:/o/a/calendar' }), [{ kind: 'page', id: 'p1' }]);
  const long = Array.from({ length: FAV_MAX }, () => ({ kind: 'route', id: `/o/${'x'.repeat(40)}/business/performance` }));
  assert.ok(JSON.stringify({ items: long }).length < 16384, '긴 주소 100개도 한 행 16KB 안');
});

// 이유(유건 10/1 5차): 홈·설정·휴지통·모듈 보관함은 사이드바 맨 위·맨 아래 고정 칸이라 즐겨찾기에 넣을 수 없다 — ☆·우클릭·⌘K 어디서도 대상이 없고,
// 이미 저장돼 있던 값은 읽을 때 걸러(다음 저장 때 자연히 빠진다). 페이지·에이전트·다른 화면은 그대로 넣을 수 있다.
test('즐겨찾기 제외: 홈·설정·휴지통·모듈 보관함은 대상이 없고 저장돼 있어도 읽을 때 걸러진다', () => {
  for (const base of ['/me', '/o/lean-ax']) {
    for (const rest of ['', '/settings', '/trash', '/business/library']) assert.equal(favTarget(base + rest), null, base + rest);
    for (const rest of ['/calendar', '/approvals', '/business', '/business/customers', '/knowhow']) assert.deepEqual(favTarget(base + rest), { kind: 'route', id: base + rest }, base + rest);
  }
  assert.deepEqual(favTarget('/me/mail'), { kind: 'route', id: '/me/mail' }, '메일은 넣을 수 있다');
  assert.deepEqual(favTarget('/o/lean-ax/p/abc'), { kind: 'page', id: 'abc' }, '페이지는 그대로');
  assert.equal(favable(routeInfo('/me/calendar')), true);
  assert.equal(favable(null), false);
  const saved = [{ kind: 'route', id: '/me' }, { kind: 'route', id: '/o/a/settings' }, { kind: 'route', id: '/o/a/trash' }, { kind: 'route', id: '/o/a/business/library' }, { kind: 'route', id: '/o/a/calendar' }, { kind: 'page', id: 'p1' }, { kind: 'crew', id: 'c1' }];
  const shown = readFav(saved, () => true);
  assert.deepEqual(shown, [{ kind: 'route', id: '/o/a/calendar' }, { kind: 'page', id: 'p1' }, { kind: 'crew', id: 'c1' }]);
  assert.deepEqual(writeFav(shown, { add: { kind: 'page', id: 'p2' } }).map((x) => x.id), ['/o/a/calendar', 'p1', 'c1', 'p2'], '다음 저장에는 제외 항목이 빠진다');
  assert.equal(saved.length, 7, '저장값은 건드리지 않는다');
});
