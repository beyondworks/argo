// 18차 분리 검수 반영 — 결함마다 고치기 전 실패하던 규칙을 잠근다(M1·M2·M4, LOW 1·2·3·6·7·10·11)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redactMenu, HIDE_ALL_NOTE, isMasked } from '../src/business/redact-rule.js';
import { redactHandlers } from '../src/business/cell-pick.js';
import { looksLikeAddr } from '../src/core/hide-all.js';
import { dueCounts, viewRows, taskOrgKeys } from '../src/core/task-model.js';
import { mergeItems, filterItems, normalizeCfg, dueFilter } from '../src/views/model.js';
import { HOME_DEFAULTS } from '../src/core/module-registry.js';
import { notifyText } from '../src/pages/mail-model.js';
import { keepResponse, cacheFresh, makeDayClock } from '../src/core/refetch.js';
import { attentionRows } from '../src/business/attention-model.js';

const ev = (extra = {}) => { const e = { button: 0, key: '', shiftKey: false, preventDefault() {}, ...extra }; return e; };
const rig = (props) => { const menu = []; const h = redactHandlers(props, () => {}, (e, items) => menu.push(items)); return { h, menu }; };

// 이유(검수 M1): 전체 가리기 중에는 화면이 이미 가려져 있어 '가리기·해제'를 눌러도 변화가 안 보이는데, 거래처 가림 같은 조직 공용 칸이 서버에서 바뀐다
// (끄면 계좌가 조직 모두에게 보이는 사고 경로). 그동안 쓰기 항목은 내지 않고 누를 수 없는 안내 한 줄만 — 끄면 원래 메뉴
test('M1: 전체 가리기 중 가리기 메뉴는 안내 한 줄', () => {
  const items = [{ label: 'bizui.redact', run: () => {} }, { label: 'bizui.unredact', run: () => {} }];
  assert.deepEqual(redactMenu(items, true), [{ heading: HIDE_ALL_NOTE }]);
  assert.deepEqual(redactMenu(items, true, (k) => `T:${k}`), [{ heading: `T:${HIDE_ALL_NOTE}` }], '이미 번역한 메뉴(고른 칸·고른 줄)에는 번역해서 넣는다');
  assert.deepEqual(redactMenu(items, false).map((x) => x.label), items.map((x) => x.label));
  assert.deepEqual(redactMenu([false, null], true), [{ heading: HIDE_ALL_NOTE }], '쓸 항목이 없어도 안내는 같다');
  // 값 하나 우클릭(카드 메뉴와 합쳐지는 inner 경로도 같은 함수를 지난다)
  const toggle = () => {};
  let r = rig({ on: true, masked: true, all: true, onToggle: toggle });
  r.h.onContextMenu(ev());
  assert.deepEqual(r.menu, [[{ heading: HIDE_ALL_NOTE }]]);
  r = rig({ on: true, masked: true, all: false, onToggle: toggle });
  r.h.onContextMenu(ev());
  assert.equal(r.menu[0][0].label, 'bizui.unredact', '전체 가리기를 끄면 원래 메뉴');
});

// 이유(검수 M2·LOW 5): 메모 칸에는 계좌·전화가 적히는 일이 있다 — 전체 가리기에서 가린다. 주소·대표자는 연락처(contact)
test('M2·LOW5: 메모·연락처 kind는 전체 가리기에서 가린다', () => {
  for (const kind of ['memo', 'contact']) assert.equal(isMasked({ all: true, kind }), true, kind);
});

// 이유(검수 M2): 보낸 사람 이름이 없으면 서버가 주소를 이름 자리에 넣는다(server/gmail.js parseAddress) — 이메일 모양이면 연락처로 보고 가린다. 이름은 그대로(결정 4)
test('M2: 이메일 모양 판정', () => {
  for (const s of ['a@b.co', ' kim.lee+x@example.co.kr ', 'Kim <kim@ex.com>']) assert.equal(looksLikeAddr(s), true, s);
  for (const s of ['김민지', 'Acme Inc.', '', null, undefined, '@handle', 'a@b']) assert.equal(looksLikeAddr(s), false, String(s));
});

// 이유(검수 M4): 내 공간 할 일 화면은 조직에서 나에게 맡긴 일까지 보인다 — 배지·챙길 것도 이미 읽어 둔 조직 행이 있으면 같은 함수로 더해 센다(없으면 개인 행만, 새 읽기 없음).
// 같은 데이터로 배지 수 = 할 일 화면에서 ?due로 거른 건수
test('M4: 배지·챙길 것 수 = 할 일 화면 거르기 건수(같은 데이터, 같은 함수)', () => {
  const me = 'u-me', now = Date.parse('2026-10-04T03:00:00Z'), today = '2026-10-04';
  const row = (id, o) => ({ id, title: id, assignee: me, created_by: me, due_on: null, done_at: null, cancelled_at: null, created_at: '2026-09-01T00:00:00Z', ...o });
  const own = [row('p1', { due_on: '2026-10-01' }), row('p2', { due_on: today }), row('p3', { due_on: '2026-10-09' })];
  const orgRows = new Map([
    ['acme', [row('o1', { due_on: '2026-10-02' }), row('o2', { due_on: today, assignee: 'u-kim' }), row('o3', { due_on: today, done_at: '2026-10-04T01:00:00Z' }), row('o4', { due_on: today })]],
    ['guestorg', [row('g1', { due_on: '2026-10-01' })]],
  ]);
  const spaces = [{ key: 'me', kind: 'me' }, { key: 'acme', kind: 'org', role: 'member' }, { key: 'guestorg', kind: 'org', role: 'guest' }];
  const orgKeys = taskOrgKeys(spaces);
  assert.deepEqual(orgKeys, ['acme'], '할 일 화면과 같은 조직(손님으로 있는 조직은 빼고)');
  const rows = viewRows({ space: 'me', own, orgRows, orgKeys, me });
  const badge = dueCounts(rows, now, me);
  assert.deepEqual(badge, { overdue: 2, today: 2 }, '개인 p1·p2 + 조직 o1·o4');
  const items = mergeItems([], rows, { from: '0000-01-01', to: '9999-12-31', undated: true });
  const base = normalizeCfg({ filter: { kind: 'task', category: '분류A', priority: '1' } }, { filter: { kind: 'task' } });
  for (const due of ['overdue', 'today']) assert.equal(filterItems(items, dueFilter(base.filter, due, me), today).length, badge[due], due);
  // 조직 행을 아직 안 읽었으면 개인 행만, 개인 행도 안 읽었으면 배지 숨김(null)
  assert.deepEqual(dueCounts(viewRows({ space: 'me', own, orgRows: new Map(), orgKeys, me }), now, me), { overdue: 1, today: 1 });
  assert.equal(dueCounts(viewRows({ space: 'me', own: undefined, orgRows, orgKeys, me }), now, me), null);
  // 조직 공간은 그 조직 행만(겹쳐 보기 없음)
  assert.deepEqual(viewRows({ space: 'acme', own: orgRows.get('acme'), orgRows, orgKeys, me }).map((x) => x.space), ['acme', 'acme', 'acme', 'acme']);
});

// 이유(검수 LOW 1): ?due로 들어오면 저장된 분류·중요도 거르기를 풀어야 배지 수와 같은 건수가 보인다(이 창에서만 — 저장하지 않는다)
test('LOW1: ?due 거르기는 분류·중요도를 푼다', () => {
  const f = dueFilter({ kind: 'task', who: 'all', category: '분류A', period: 'all', status: 'all', priority: '1' }, 'today', 'u-me');
  assert.deepEqual(f, { kind: 'task', who: 'p:u-me', category: 'all', period: 'today', status: 'open', priority: 'all' });
  assert.equal(dueFilter({ kind: 'task' }, 'nope', 'u-me'), null, '모르는 값은 거르지 않는다');
});

// 이유(검수 LOW 2): 배치를 저장한 적 없는 기존 공간은 기본 배치를 그대로 받는다 — 기존 순서는 바꾸지 않고 '챙길 것'만 현황 바로 뒤에 끼운다
test('LOW2: 기본 배치는 기존 순서 그대로 + 챙길 것만 현황 뒤', () => {
  const HEAD = {
    me: ['stats:full', 'approvals:m', 'mail:m', 'todos:l', 'pages:s', 'calendar:m', 'work:m'],
    org: ['stats:full', 'approvals:m', 'work:m', 'outputs:l', 'journal:s', 'decisions:full', 'calendar:m', 'todos:m'],
  };
  for (const kind of ['me', 'org']) {
    const list = HOME_DEFAULTS[kind].map((d) => `${d.id}:${d.size}`);
    assert.equal(list[1], 'attention:m', kind);
    assert.deepEqual(list.filter((x) => !x.startsWith('attention:')), HEAD[kind], kind);
  }
});

// 이유(검수 LOW 3): 전체 가리기 중에는 OS 알림도 화면 밖으로 보낸 사람·제목을 내보이지 않는다 — "새 메일 N통"만
test('LOW3: 전체 가리기 중 새 메일 알림은 통 수만', () => {
  const mail = (i, o) => ({ id: `a.${i}`, from: '박지현', addr: 'park@ex.com', subject: '견적', ...o });
  assert.deepEqual(notifyText([mail(1)], 'ko', true), { title: '새 메일 1통', body: '', id: 'a.1' });
  assert.deepEqual(notifyText([mail(1), mail(2, { from: '김' })], 'en', true), { title: '2 new emails', body: '', id: null });
  assert.equal(notifyText([mail(1)], 'ko', false).title, '박지현', '끄면 그대로');
});

// 이유(검수 LOW 6): 자정을 넘긴 뒤 탭으로 돌아오면 '오늘'을 다시 계산한다 — 날짜가 바뀐 때만 알린다(다시 그리기 한 번)
test('LOW6: 날짜 시계는 한국 날짜가 바뀔 때만 바뀐다', () => {
  const clock = makeDayClock(Date.parse('2026-10-04T14:00:00Z')); // 한국 10/4 23:00
  assert.equal(clock.day(), '2026-10-04');
  assert.equal(clock.check(Date.parse('2026-10-04T14:59:59Z')), false);
  assert.equal(clock.check(Date.parse('2026-10-04T15:00:00Z')), true, '한국 자정');
  assert.equal(clock.day(), '2026-10-05');
  assert.equal(clock.check(Date.parse('2026-10-04T20:00:00Z')), false);
  assert.deepEqual(dueCounts([{ id: 'x', assignee: 'm', due_on: '2026-10-04' }], clock.day(), 'm'), { overdue: 1, today: 0 }, 'dueCounts는 날짜 글자도 받는다');
});

// 이유(검수 LOW 7): 할 일 읽기가 실패하면 '확인하는 중…'에 머물지 않고 실패를 알린다(다시 시도 단추와 함께)
test('LOW7: 할 일 읽기 실패는 기다림이 아니다', () => {
  const out = attentionRows({ due: null, dueError: true, approvals: 1, biz: { overdue: 0, uninvoiced: 0 } }, '/me');
  assert.equal(out.pending, false);
  assert.equal(out.taskFail, true);
  assert.deepEqual(out.rows.map((x) => x.key), ['approvals']);
  assert.equal(attentionRows({ due: { overdue: 0, today: 0 } }, '/me').taskFail, false);
});

// 이유(검수 LOW 10): 계정을 바꾸는 사이 늦게 온 응답이 새 계정 화면에 섞이면 안 된다 — 요청 때와 지금 계정이 다르면 버린다.
// 탭 복귀 읽기는 그 사이 쓰기가 있었거나 더 새 읽기가 먼저 끝났으면 버린다
test('LOW10: 응답 버리기 판정', () => {
  assert.equal(keepResponse({ owner: 'u1', nowOwner: 'u1' }), true);
  assert.equal(keepResponse({ owner: 'u1', nowOwner: 'u2' }), false, '계정이 바뀜');
  assert.equal(keepResponse({ owner: 'u1', nowOwner: 'u1', quiet: true, writing: 1 }), false, '탭 복귀 읽기 중 쓰기');
  assert.equal(keepResponse({ owner: 'u1', nowOwner: 'u1', quiet: true, started: 10, newerAt: 11 }), false, '더 새 읽기가 먼저 끝남');
  assert.equal(keepResponse({ owner: 'u1', nowOwner: 'u1', quiet: false, writing: 1 }), true, '보통 읽기는 쓰기 중에도 받는다(쓰기 뒤 다시 읽기가 이것)');
});

// 이유(검수 LOW 11, DB 위생): 업무 카드가 없는 홈의 '챙길 것'은 열 때마다 거래를 다시 읽지 않는다 — 같은 계정·같은 공간이면 30초 안에 받은 것을 쓴다
test('LOW11: 거래 읽기 30초 캐시', () => {
  const e = { owner: 'u1', at: 1_000 };
  assert.equal(cacheFresh(e, { now: 30_999, owner: 'u1' }), true);
  assert.equal(cacheFresh(e, { now: 31_000, owner: 'u1' }), false, '30초');
  assert.equal(cacheFresh(e, { now: 2_000, owner: 'u2' }), false, '다른 계정');
  assert.equal(cacheFresh(undefined, { now: 2_000, owner: 'u1' }), false);
});

// 이유(2차 검수 LOW-A): 메뉴·선택 막대를 그린 뒤 ⌘⇧H로 전체 가리기를 켜면 그려 둔 '가리기 해제'가 남아, 누르면 조직 공용 가림이 화면 변화 없이 꺼졌다 — 누르는 순간 다시 보고 쓰지 않는다
test('LOW-A: 가리기를 끈 채 그린 메뉴도 누르는 순간 전체 가리기가 켜져 있으면 쓰지 않는다', () => {
  let ran = 0, all = false;
  const items = redactMenu([{ label: 'bizui.unredact', run: () => { ran += 1; } }, false], false, (k) => k, () => all);
  items[0].run(); assert.equal(ran, 1, '꺼진 채로 누르면 쓴다');
  all = true; items[0].run(); assert.equal(ran, 1, '그사이 켜졌으면 쓰지 않는다');
  assert.equal(items[1], false, '빈 항목은 그대로(메뉴가 걸러 낸다)');
  const bar = readFileSync(new URL('../src/ui/SelectionBar.jsx', import.meta.url), 'utf8');
  assert.match(bar, /useHideAll\(\)/, '선택 막대는 전체 가리기를 켜고 끌 때 다시 그린다');
});
