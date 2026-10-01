// 첫 사용 안내(유건 결정 2026-10-01) — 단계 계산·띄울지 판정·요소가 없을 때 대체·서버 호출 횟수·카드 자리
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DESKTOP_STEPS, PHONE_STEPS, PHONE_TABS_MARK, guideSteps, GUIDE_START_PAGES, GUIDE_VERSION, GUIDE_KEY, resolveStep, readGuideRecord, writeGuideRecord, guidePlan, rpcFailure, guideDecision,
  shouldRecord, guideReady, guideCalm, guideOnLaunch, guideOnFinish, usableBox, mostlyVisible, spotRect, tooTall, clipTo, placeCard,
} from '../src/guide.mjs';
import { DICT } from '../src/i18n.js';

const memStore = (init = {}) => { const m = new Map(Object.entries(init)); let writes = 0; return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { writes++; m.set(k, String(v)); }, get writes() { return writes; } }; };
const step = (id) => [...DESKTOP_STEPS, ...PHONE_STEPS].find((s) => s.id === id);

test('단계 목록 — 데스크톱(지금 폰 셸 포함)은 공간 전환부터 6단계, 새 폰 셸은 아래 탭 순서 5단계', () => {
  assert.deepEqual(DESKTOP_STEPS.map((s) => s.id), ['space', 'friends', 'chat', 'agents', 'call', 'org']);
  assert.deepEqual(PHONE_STEPS.map((s) => s.id), ['p-friends', 'p-chats', 'p-channels', 'p-agents', 'p-memory']);
  assert.equal(guideSteps({ phone: false, phoneTabs: true }), DESKTOP_STEPS, '데스크톱은 지금 화면 기준');
  assert.equal(guideSteps({ phone: true, phoneTabs: false }), DESKTOP_STEPS, '새 셸 표지가 없으면 지금 폰 셸 표');
  assert.equal(guideSteps({ phone: true, phoneTabs: true }), PHONE_STEPS);
  assert.equal(guideSteps(), DESKTOP_STEPS);
  // 새 셸이 붙일 표지 — 아래 탭 다섯 개는 모두 짚는다
  const sels = PHONE_STEPS.flatMap((s) => s.targets.map((tg) => tg.sel));
  for (const tab of ['friends', 'chats', 'channels', 'agents', 'memory']) assert.ok(sels.includes(`[data-tour="tab-${tab}"]`), tab);
  for (const mark of ['hdr-add-friend', 'hdr-new-chat', 'org-switch', 'approvals-card']) assert.ok(sels.includes(`[data-tour="${mark}"]`), mark); // phone-v2-spec 표지
  assert.equal(PHONE_STEPS.at(-1).note, 'guide.p.again', '폰은 톱니(내 설정) 안 다시 보기'); assert.equal(DESKTOP_STEPS.at(-1).note, 'guide.again');
  assert.equal(PHONE_TABS_MARK, '[data-tour^="tab-"]');
  assert.ok(!DESKTOP_STEPS.flatMap((s) => s.targets.map((tg) => tg.sel)).some((x) => /data-tour="tab-/.test(x)), '지금 셸 표지(chat-tab)는 새 셸 판별에 걸리지 않는다');
});

test('새 폰 셸 — 그 탭이 열려 있으면 오른쪽 위 버튼을, 아니면 아래 탭을, 표지가 없으면 가운데', () => {
  const f = step('p-friends');
  assert.equal(resolveStep(f, (tg) => tg.sel.includes('hdr-add-friend')).body, 'guide.p.friends.add');
  const tab = resolveStep(f, (tg) => tg.sel.includes('tab-friends'));
  assert.equal(tab.target.sel, '[data-tour="tab-friends"]'); assert.equal(tab.body, 'guide.p.friends.tab');
  const none = resolveStep(f, () => false);
  assert.equal(none.target, null); assert.equal(none.body, 'guide.p.friends.tab', '가운데 안내도 같은 설명');
  assert.equal(resolveStep(step('p-channels'), (tg) => tg.sel.includes('org-switch')).body, 'guide.p.channels.org');
});

test('보이는 첫 대상을 짚고, 대상마다 문구를 바꾸며, 하나도 없으면 가운데 안내 문구로 대신한다', () => {
  const chat = step('chat');
  const a = resolveStep(chat, (tg) => tg.sel.includes('chat-new'));
  assert.equal(a.target.sel, '[data-tour="chat-new"]'); assert.equal(a.body, 'guide.chat.body');
  const b = resolveStep(chat, (tg) => tg.sel.includes('chat-tab')); // 폰 홈: + 대신 아래 채팅 탭
  assert.equal(b.target.sel, '[data-tour="chat-tab"]'); assert.equal(b.body, 'guide.chat.tab');
  const c = resolveStep(chat, () => false); // 조직도 개인 공간도 아닌 첫 화면 — 빈 자리를 가리키지 않는다
  assert.equal(c.target, null); assert.equal(c.body, 'guide.chat.fallback');
  const f = resolveStep(step('friends'), () => false);
  assert.equal(f.body, 'guide.friends.fallback', '조직에 있을 때 친구 +는 없다 — 개인 공간에 있다고 알려 준다');
  const seen = []; resolveStep(chat, (tg) => { seen.push(tg.sel); return true; });
  assert.deepEqual(seen, ['[data-tour="chat-new"]'], '찾으면 뒤 후보는 보지 않는다');
});

test('모든 단계 문구는 ko/en 둘 다 있고, 내부 용어(크루·레일·워크스페이스)를 쓰지 않는다', () => {
  const keys = new Set(['guide.label', 'guide.count', 'guide.next', 'guide.prev', 'guide.skip', 'guide.done', 'guide.keys', 'guide.again', 'set.guide', 'set.guide.desc', 'set.guide.replay']);
  for (const s of [...DESKTOP_STEPS, ...PHONE_STEPS]) { keys.add(s.title); keys.add(s.body); if (s.fallback) keys.add(s.fallback); if (s.note) keys.add(s.note); for (const tg of s.targets) if (tg.body) keys.add(tg.body); }
  for (const k of keys) {
    const row = DICT[k];
    assert.ok(Array.isArray(row) && row[0] && row[1], `${k}: ko/en`);
    assert.doesNotMatch(row[0], /크루|레일|워크스페이스|파견|노드/, `${k}: 내부 용어`);
    assert.doesNotMatch(row[1], /\bcrew|\brail\b|workspace|dispatch/i, `${k}: internal term`);
  }
  // 화면에 실제로 보이는 이름을 그대로 쓴다 — 조직 메뉴 항목 이름과 같다
  assert.ok(DICT['guide.org.body'][0].includes(DICT['org.new'][0]) && DICT['guide.org.body'][0].includes(DICT['org.join.code'][0]));
  assert.ok(DICT['guide.call.body'][0].includes(DICT['ch.add.crew'][0]));
  assert.ok(DICT['guide.again'][0].includes(DICT['set.guide.replay'][0]) && DICT['guide.again'][0].includes(DICT['set.tab.me'][0]));
});

test('기기 기록 — 계정별로 읽고 쓰며, 같은 값은 다시 쓰지 않고, 저장소가 막혀도 던지지 않는다', () => {
  const st = memStore();
  assert.deepEqual(readGuideRecord(st, 'u1'), { v: 0, synced: false });
  assert.equal(writeGuideRecord(st, 'u1', { v: 1, synced: false }), true);
  assert.equal(writeGuideRecord(st, 'u1', { v: 1, synced: false }), false, '같은 값 — 쓰기 0');
  assert.deepEqual(readGuideRecord(st, 'u1'), { v: 1, synced: false });
  assert.deepEqual(readGuideRecord(st, 'u2'), { v: 0, synced: false }, '다른 계정은 따로');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(readGuideRecord(broken, 'u1'), { v: 0, synced: false });
  assert.equal(writeGuideRecord(broken, 'u1', { v: 1, synced: true }), false);
  assert.deepEqual(readGuideRecord(memStore({ [GUIDE_KEY]: '{not json' }), 'u1'), { v: 0, synced: false });
  assert.deepEqual(readGuideRecord(null, 'u1'), { v: 0, synced: false });
});

test('띄울지 판정 — 기기에서 봤으면 묻지 않고, 서버가 답 못 하면 기기 기록으로 물러난다', () => {
  assert.equal(guidePlan({ v: 0, synced: false }), 'check');
  assert.equal(guidePlan({ v: GUIDE_VERSION, synced: true }), 'done');
  assert.equal(guidePlan({ v: GUIDE_VERSION, synced: 'local' }), 'done', '옛 서버 — 다시 시도하지 않는다');
  assert.equal(guidePlan({ v: GUIDE_VERSION, synced: false }), 'sync', '지난번 서버 기록 실패(오프라인) — 기록만 다시');
  assert.equal(guidePlan({ v: 1, synced: true }, 2), 'check', '판 번호가 오르면 다시 보여 준다');
  assert.equal(guideDecision({ v: 0 }), 'show'); assert.equal(guideDecision({ v: GUIDE_VERSION }), 'seen');
  assert.equal(guideDecision({ fail: 'missing' }), 'show'); assert.equal(guideDecision({ fail: 'error' }), 'show');
  assert.equal(rpcFailure({ code: 'PGRST202', message: 'x' }), 'missing');
  assert.equal(rpcFailure({ message: 'Could not find the function public.msgr_my_guide_seen without parameters in the schema cache' }), 'missing');
  assert.equal(rpcFailure({ code: '42883', message: 'function does not exist' }), 'missing');
  assert.equal(rpcFailure({ message: 'TypeError: Failed to fetch' }), 'error');
  assert.equal(rpcFailure(new Error('timeout')), 'error');
  assert.equal(shouldRecord({ v: GUIDE_VERSION, synced: true }), false, '다시 보기 — 쓰지 않는다');
  assert.equal(shouldRecord({ v: 0, synced: false }), true);
});

// 서버 흉내 — 호출을 센다. mode: ok(새 서버) | missing(옛 서버) | offline
const fakeServer = (mode = 'ok', seen = null) => {
  const calls = []; let row = seen;
  const rpc = async (name, args) => {
    calls.push(name);
    if (mode === 'offline') throw new TypeError('Failed to fetch');
    if (mode === 'missing') return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
    if (name === 'msgr_my_guide_seen') return { data: row, error: null };
    if (name === 'msgr_mark_guide_seen') { if (row == null || row < args.p_version) row = args.p_version; return { data: null, error: null }; }
    return { data: null, error: { message: 'unknown' } };
  };
  return { rpc, calls, get row() { return row; }, set mode(m) { mode = m; } };
};

test('새 서버 — 첫 실행에 읽기 1·끝낼 때 쓰기 1, 그 뒤 실행은 호출 0, 다시 보기도 쓰기 0', async () => {
  const storage = memStore(); const srv = fakeServer('ok'); const io = { storage, uid: 'u1', rpc: srv.rpc };
  assert.equal(await guideOnLaunch(io), true);
  assert.deepEqual(srv.calls, ['msgr_my_guide_seen']);
  assert.equal(await guideOnFinish(io), true);
  assert.deepEqual(srv.calls, ['msgr_my_guide_seen', 'msgr_mark_guide_seen']); assert.equal(srv.row, GUIDE_VERSION);
  for (let i = 0; i < 3; i++) assert.equal(await guideOnLaunch(io), false);
  assert.equal(srv.calls.length, 2, '앱을 열 때마다 호출하지 않는다');
  assert.equal(await guideOnFinish(io), false, '다시 보기 끝 — 이미 남아 있다');
  assert.equal(srv.calls.length, 2);
});

test('다른 기기에서 이미 봤으면 띄우지 않고, 이 기기에도 남겨 다음부터 묻지 않는다', async () => {
  const storage = memStore(); const srv = fakeServer('ok', GUIDE_VERSION); const io = { storage, uid: 'u1', rpc: srv.rpc };
  assert.equal(await guideOnLaunch(io), false);
  assert.equal(await guideOnLaunch(io), false);
  assert.deepEqual(srv.calls, ['msgr_my_guide_seen']);
});

test('옛 서버(함수 없음) — 기기 기록으로 띄우고 한 번 끝내면 다시 안 뜨며, 실패할 호출을 반복하지 않는다', async () => {
  const storage = memStore(); const srv = fakeServer('missing'); const io = { storage, uid: 'u1', rpc: srv.rpc };
  assert.equal(await guideOnLaunch(io), true);
  await guideOnFinish(io);
  assert.deepEqual(readGuideRecord(storage, 'u1'), { v: GUIDE_VERSION, synced: 'local' });
  assert.equal(await guideOnLaunch(io), false);
  assert.deepEqual(srv.calls, ['msgr_my_guide_seen', 'msgr_mark_guide_seen']);
});

test('오프라인 — 기기 기록으로 띄우고, 끝낸 기록은 기기에 남아 다시 안 뜨며, 다음 실행에 서버 기록만 한 번 다시', async () => {
  const storage = memStore(); const srv = fakeServer('offline'); const io = { storage, uid: 'u1', rpc: srv.rpc };
  assert.equal(await guideOnLaunch(io), true, '서버가 답 못 함 — 기기에서 안 봤으니 띄운다');
  await guideOnFinish(io);
  assert.deepEqual(readGuideRecord(storage, 'u1'), { v: GUIDE_VERSION, synced: false });
  srv.mode = 'ok';
  assert.equal(await guideOnLaunch(io), false, '다시 뜨지 않는다');
  assert.deepEqual(srv.calls.slice(-1), ['msgr_mark_guide_seen'], '밀린 기록 한 번');
  assert.equal(srv.row, GUIDE_VERSION);
  assert.equal(await guideOnLaunch(io), false);
  assert.equal(srv.calls.filter((c) => c === 'msgr_mark_guide_seen').length, 2, '오프라인 1 + 다시 1, 그 뒤 0');
});

test('기기 저장이 막혀도(사파리 개인 정보 보호) 서버 기록으로 판정한다', async () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const srv = fakeServer('ok'); const io = { storage: broken, uid: 'u1', rpc: srv.rpc };
  assert.equal(await guideOnLaunch(io), true);
  await guideOnFinish(io);
  assert.equal(await guideOnLaunch(io), false, '서버가 봤다고 답한다');
});

test('시작 조건 — 다른 창·입력 중·스플래시면 기다리고, 폰은 홈 탭·데스크톱은 대화 화면에서만', () => {
  const base = { loaded: true, phone: false, page: 'chat' };
  assert.equal(guideReady(base), true);
  assert.equal(guideReady({ ...base, loaded: false }), false);
  assert.equal(guideReady({ ...base, blockers: [false, 'sheet', null] }), false, '시트·초대·동의 창');
  assert.equal(guideReady({ ...base, modalOpen: true }), false);
  assert.equal(guideReady({ ...base, typing: true }), false);
  assert.equal(guideReady({ ...base, splash: true }), false);
  assert.equal(guideCalm(), true); assert.equal(guideCalm({ modalOpen: true }), false); assert.equal(guideCalm({ typing: true }), false); assert.equal(guideCalm({ splash: true }), false);
  assert.equal(guideReady({ ...base, page: 'settings' }), false);
  assert.equal(guideReady({ ...base, phone: true, page: 'home' }), true);
  assert.deepEqual(GUIDE_START_PAGES, { desktop: ['chat'], phone: ['home'] }, '새 폰 셸은 아래 탭 루트 화면 이름을 phone에 더한다');
  assert.equal(guideReady({ ...base, phone: true, page: 'dm' }), false, '폰 채팅 탭엔 공간 버튼이 없다 — 홈에서');
  assert.equal(guideReady({ ...base, phone: true, page: 'chat' }), false);
});

const desk = { w: 1440, h: 900 }; const phoneView = { w: 390, h: 844 }; const notch = { top: 47, right: 0, bottom: 34, left: 0 };
// 화면 안 판정은 직접 계산한다(usableBox를 쓰면 같은 함수로 같은 함수를 검사하게 된다 — 변이 시험에서 안전 영역 무시가 통과했다)
const inside = (p, card, view, safe = {}) => { const t = safe.top ?? 0, r = safe.right ?? 0, b = safe.bottom ?? 0, l = safe.left ?? 0; return p.x >= l && p.y >= t && p.x + card.w <= view.w - r && p.y + card.h <= view.h - b; };
const overlaps = (p, card, s) => p.x < s.left + s.width && p.x + card.w > s.left && p.y < s.top + s.height && p.y + card.h > s.top;

test('카드 자리 — 데스크톱은 왼쪽 목록의 오른쪽, 겹치지 않고 화면 안', () => {
  const card = { w: 320, h: 190 };
  const spot = { left: 10, top: 60, width: 240, height: 40 }; // 공간 버튼
  const p = placeCard({ spot, card, view: desk, safe: {} });
  assert.equal(p.side, 'right'); assert.ok(inside(p, card, desk)); assert.ok(!overlaps(p, card, spot));
  const low = { left: 10, top: 860, width: 240, height: 30 }; // 화면 아래쪽 대상 — 카드가 밑으로 넘치지 않게 끌어올린다
  const q = placeCard({ spot: low, card, view: desk, safe: {} });
  assert.equal(q.side, 'right'); assert.ok(inside(q, card, desk));
  const narrow = { w: 800, h: 600 };
  const r = placeCard({ spot: { left: 8, top: 300, width: 244, height: 200 }, card, view: narrow, safe: {} });
  assert.ok(inside(r, card, narrow)); assert.ok(!overlaps(r, card, { left: 8, top: 300, width: 244, height: 200 }));
});

test('카드 자리 — 폰은 위·아래, 노치(47)·홈 바(34) 안쪽에서 대상과 겹치지 않는다', () => {
  const card = { w: 366, h: 200 };
  const title = { left: 14, top: 100, width: 200, height: 44 }; // 홈 큰 제목(공간 버튼)
  const a = placeCard({ spot: title, card, view: phoneView, safe: notch, phone: true });
  assert.equal(a.side, 'below'); assert.ok(inside(a, card, phoneView, notch)); assert.ok(!overlaps(a, card, title));
  const fab = { left: 312, top: 700, width: 64, height: 64 }; // 오른쪽 아래 + 버튼
  const b = placeCard({ spot: fab, card, view: phoneView, safe: notch, phone: true });
  assert.equal(b.side, 'above'); assert.ok(inside(b, card, phoneView, notch)); assert.ok(!overlaps(b, card, fab));
  const tab = { left: 100, top: 760, width: 80, height: 56 }; // 하단 채팅 탭
  const c = placeCard({ spot: tab, card, view: phoneView, safe: notch, phone: true });
  assert.equal(c.side, 'above'); assert.ok(inside(c, card, phoneView, notch));
  const landscape = { w: 844, h: 390 }; const side = { top: 0, right: 47, bottom: 21, left: 47 }; // 가로로 돌린 폰
  const d = placeCard({ spot: { left: 60, top: 150, width: 200, height: 60 }, card: { w: 360, h: 200 }, view: landscape, safe: side, phone: true });
  assert.ok(inside(d, { w: 360, h: 200 }, landscape, side));
});

test('대상이 없으면 가운데, 카드가 남는 칸보다 커도 화면 밖으로 나가지 않는다', () => {
  const card = { w: 320, h: 200 };
  const c = placeCard({ spot: null, card, view: phoneView, safe: notch, phone: true });
  assert.equal(c.side, 'center'); assert.ok(inside(c, card, phoneView, notch));
  const big = { left: 0, top: 120, width: 390, height: 600 }; // 위아래 모두 카드가 안 들어가는 큰 대상
  const d = placeCard({ spot: big, card, view: phoneView, safe: notch, phone: true });
  assert.ok(inside(d, card, phoneView, notch));
});

test('강조 영역 — 안전 영역 안으로 자르고, 스크롤 칸에 잘린 부분은 빼며, 긴 목록은 머리만', () => {
  const s = spotRect({ left: 0, top: 0, width: 120, height: 40 }, { view: phoneView }); // 화면 가장자리에 붙은 대상
  assert.ok(s.top >= 0 && s.left >= 0, '화면 밖으로 나가지 않는다');
  const tab = spotRect({ left: 92, top: 772, width: 68, height: 52 }, { view: phoneView }); // 홈 바 자리에 걸친 하단 채팅 탭(390×844 실측)
  assert.ok(tab.top + tab.height >= 824, '탭 글자를 자르지 않는다'); assert.ok(tab.top + tab.height <= 842);
  assert.equal(spotRect({ left: 0, top: 900, width: 100, height: 40 }, { view: phoneView }), null);
  assert.equal(tooTall({ height: 700 }, phoneView, 0.4), true); assert.equal(tooTall({ height: 120 }, phoneView, 0.4), false);
  // 데스크톱 실측(2026-10-01): 에이전트 구역 254px 중 아래 26px가 레일 스크롤 칸 밖(발판 뒤) — 강조가 발판까지 번졌다
  const rail = { left: 0, top: 150, width: 268, height: 693 };
  assert.deepEqual(clipTo({ left: 8, top: 615, width: 251, height: 254 }, [rail]), { left: 8, top: 615, width: 251, height: 228 });
  assert.equal(clipTo({ left: 8, top: 860, width: 251, height: 30 }, [rail]), null, '칸 밖으로 완전히 나감');
  assert.equal(mostlyVisible({ left: 0, top: 830, width: 100, height: 40 }, usableBox(phoneView, null, 0)), false, '반 넘게 화면 밖');
  assert.equal(mostlyVisible({ left: 92, top: 772, width: 68, height: 52 }, usableBox(phoneView, null, 0), 0.9), true, '탭 바는 보인다');
  assert.equal(mostlyVisible({ left: 10, top: 200, width: 100, height: 40 }, usableBox(phoneView, notch, 0)), true);
});

test('배선 — 짚는 요소에 data-tour 표지가 있고, 선택자는 guide.mjs 표 한 곳에만 있다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  for (const name of ['space', 'friend-add', 'chat-new', 'chat-tab', 'room-title']) assert.match(app, new RegExp(`data-tour[=:{ '"]+[^>]*${name}`), name);
  assert.doesNotMatch(app, /data-guide=/, '표지 이름은 data-tour 하나');
  assert.match(app, /data-sec=\{id\}/, '에이전트 목록은 구역 표지(data-sec="mine")로 찾는다');
  const jsx = readFileSync(new URL('../src/guide.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(jsx, /data-tour|data-sec=/, '화면 쪽에 선택자를 흩지 않는다');
  assert.match(app, /onReplayGuide=\{replayGuide\}/, '설정의 사용법 다시 보기');
  assert.match(app, /guideOnLaunch\(guideIo\)/); assert.match(app, /guideOnFinish\(guideIo\)/);
});
