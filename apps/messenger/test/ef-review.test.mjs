// #793 독립 검수 반영(2026-10-01) — 원인별 검색 실패 문구, 첨부 실패 카드, 카드·검색 화면 선택 규칙, 개인 공간 내 이름 조회, 연결 상태 재확인.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createComposerDelivery, setDeliveryReporter } from '../src/composer-delivery.mjs';
import { fetchSearchRows } from '../src/search-rows.mjs';
import { searchView } from '../src/search-view.mjs';
import { deliveryCardView } from '../src/delivery-card.mjs';
import { fetchSelfName } from '../src/self-member.mjs';
import { watchOnline } from '../src/connection.mjs';
import { crewOpeners, creatorTagVisible } from '../src/crew-row-menu.mjs';
import { t } from '../src/i18n.js';

const transport = (o = {}) => ({ message: async () => 7, upload: async () => {}, attachment: async () => {}, ...o });
const file = (name) => ({ name, size: 4, type: 'text/plain' });

test('검색 실패는 원인을 가른다 — 네트워크면 offline, 그 밖(서버 오류·시간 초과)이면 error', async () => {
  assert.equal((await fetchSearchRows(async () => { throw new TypeError('Failed to fetch'); }, 2)).failed, 'offline');
  assert.equal((await fetchSearchRows(async () => { throw new Error('canceling statement due to statement timeout'); }, 2)).failed, 'error');
  assert.equal((await fetchSearchRows(async () => [1], 2)).failed, false);
});

test('searchView: 실패 원인·결과 수에 따라 안내가 갈린다(일부만 / 하나도 못 찾음), 실패했으면 "결과가 없습니다"를 말하지 않는다', () => {
  const res = (failed) => ({ failed });
  assert.deepEqual(searchView({ res: null, busy: true, total: 0, phone: false }), { loading: true, hintKey: null, noticeKey: null, noneKey: null });
  assert.equal(searchView({ res: null, busy: false, total: 0, phone: false }).hintKey, 'search.hint');
  assert.equal(searchView({ res: null, busy: false, total: 0, phone: true }).hintKey, 'search.hint.phone');
  assert.equal(searchView({ res: res(false), busy: false, total: 0 }).noneKey, 'search.none');
  assert.equal(searchView({ res: res(false), busy: false, total: 2 }).noneKey, null);
  assert.equal(searchView({ res: res('offline'), busy: false, total: 2 }).noticeKey, 'search.partial');
  assert.equal(searchView({ res: res('error'), busy: false, total: 2 }).noticeKey, 'search.partial.error');
  assert.equal(searchView({ res: res('offline'), busy: false, total: 0 }).noticeKey, 'search.failed');
  assert.equal(searchView({ res: res('error'), busy: false, total: 0 }).noticeKey, 'search.failed.error');
  assert.equal(searchView({ res: res('error'), busy: false, total: 0 }).noneKey, null);
  for (const k of ['search.partial', 'search.partial.error', 'search.failed', 'search.failed.error']) { assert.notEqual(t(k, 'ko'), k, k); assert.notEqual(t(k, 'en'), k, k); }
  assert.equal(t('search.partial.error', 'ko'), '검색을 마치지 못해 일부만 보입니다. 잠시 뒤 다시 검색해 주세요.');
});

test('첨부 실패: 모든 실패가 네트워크일 때만 offline 문구 — 일부만 네트워크면 원문 줄을 그대로(원인을 숨기지 않는다)', async () => {
  setDeliveryReporter(() => {});
  try {
    const mixed = createComposerDelivery(transport({ upload: async (_j, item) => { throw new Error(item.file.name === 'a.txt' ? 'Load failed' : 'new row violates row-level security policy'); } }));
    mixed.setFiles([file('a.txt'), file('b.txt')]); await mixed.send([]);
    assert.equal(mixed.snapshot().job.errorKey, '');
    assert.match(mixed.snapshot().job.error, /b\.txt: new row violates/);
    const all = createComposerDelivery(transport({ upload: async () => { throw new TypeError('Load failed'); } }));
    all.setFiles([file('a.txt'), file('b.txt')]); await all.send([]);
    assert.equal(all.snapshot().job.errorKey, 'msg.delivery.offline');
  } finally { setDeliveryReporter(null); }
});

test('uiKey가 있으면 네트워크 문구가 같이 있어도 uiKey가 이긴다(세션 만료 안내를 연결 끊김으로 덮지 않는다)', async () => {
  const reported = []; setDeliveryReporter((...a) => reported.push(a));
  try {
    const s = createComposerDelivery(transport({ message: async () => { throw Object.assign(new TypeError('Failed to fetch'), { uiKey: 'msg.delivery.authExpired' }); } }));
    s.setText('x'); await s.send([]);
    assert.equal(s.snapshot().job.errorKey, 'msg.delivery.authExpired');
    assert.deepEqual(reported, [], 'uiKey 경로는 연결 끊김 진단으로 세지 않는다');
  } finally { setDeliveryReporter(null); }
});

test('deliveryCardView: 카드 제목과 오류 줄 — 보내는 중 / 연결 끊김 / 첨부 일부 실패 / 그 밖 실패', () => {
  const job = (o = {}) => ({ messageId: null, error: '', errorKey: '', files: [], ...o });
  assert.equal(deliveryCardView({ busy: true, job: job() }).titleKey, 'msg.delivery.sending');
  const off = deliveryCardView({ busy: false, job: job({ error: 'TypeError: Failed to fetch', errorKey: 'msg.delivery.offline' }) });
  assert.deepEqual([off.titleKey, off.errorLine], ['msg.delivery.offline', null], '연결 끊김 카드는 제목이 곧 안내 — 오류 줄 없음');
  const att = deliveryCardView({ busy: false, job: job({ messageId: 7, error: 'a.txt: Load failed', errorKey: 'msg.delivery.offline', files: [{ file: { name: 'a.txt' }, done: false }, { file: { name: 'ok.txt' }, done: true }] }) });
  assert.equal(att.titleKey, 'msg.delivery.attachFailed');
  assert.deepEqual(att.errorLine, { key: 'msg.delivery.offline', raw: null, files: ['a.txt'] }, '실패한 파일 이름을 남긴다');
  const auth = deliveryCardView({ busy: false, job: job({ error: 'JWT', errorKey: 'msg.delivery.authExpired' }) });
  assert.deepEqual([auth.titleKey, auth.errorLine], ['msg.delivery.failed', { key: 'msg.delivery.authExpired', raw: null, files: [] }]);
  const upd = deliveryCardView({ busy: false, job: job({ error: 'msgr_runtime_update_required' }) });
  assert.deepEqual(upd.errorLine, { key: 'dm.delivery.blocked', raw: null, files: [] });
  const other = deliveryCardView({ busy: false, job: job({ error: 'new row violates row-level security policy' }) });
  assert.deepEqual([other.titleKey, other.errorLine], ['msg.delivery.failed', { key: null, raw: 'new row violates row-level security policy', files: [] }]);
});

test('fetchSelfName: 내 이름은 msgr_people_names([나]) 한 번 — 못 읽으면 빈 문자열(호출한 쪽이 다른 근거로 물러난다)', async () => {
  const calls = [];
  const rpc = async (fn, args) => { calls.push([fn, args]); return [{ user_id: 'other', name: '남' }, { user_id: 'me', name: ' 유건 ' }]; };
  assert.equal(await fetchSelfName(rpc, 'me'), '유건');
  assert.deepEqual(calls, [['msgr_people_names', { ids: ['me'] }]]);
  assert.equal(await fetchSelfName(async () => { throw new Error('Could not find the function'); }, 'me'), '');
  assert.equal(await fetchSelfName(async () => [], 'me'), '');
});

test('watchOnline: 앱이 다시 보일 때(visibilitychange) 연결 상태를 다시 읽는다 — 백그라운드 중 놓친 online/offline 이벤트', () => {
  const win = new EventTarget(); win.navigator = { onLine: false }; win.document = new EventTarget(); win.document.visibilityState = 'visible';
  const seen = []; watchOnline((v) => seen.push(v), win);
  win.navigator.onLine = true; win.document.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(seen, [false, true]);
});

test('crewOpeners·creatorTagVisible: 개인 공간 규칙', () => {
  const sheet = () => 'sheet'; const dm = () => 'dm';
  assert.equal(crewOpeners({ isPersonal: true, openSheet: sheet, openDm: dm }).channel, null, '개인 방 메시지의 에이전트 버튼은 없다');
  assert.equal(crewOpeners({ isPersonal: true, openSheet: sheet, openDm: dm }).search, dm);
  assert.equal(crewOpeners({ isPersonal: false, openSheet: sheet, openDm: dm }).channel, sheet);
  assert.equal(crewOpeners({ isPersonal: false, openSheet: sheet, openDm: dm }).search, sheet);
  assert.equal(creatorTagVisible({ isCreator: true, isPersonal: true, isGroup: false }), false, '개인 1:1은 만든 사람이 없다');
  assert.equal(creatorTagVisible({ isCreator: true, isPersonal: true, isGroup: true }), true);
  assert.equal(creatorTagVisible({ isCreator: true, isPersonal: false, isGroup: false }), true);
  assert.equal(creatorTagVisible({ isCreator: false, isPersonal: false, isGroup: false }), false);
});

// 화면 배선 — 위 순수 함수를 App이 실제로 쓰는지(소스 확인은 보조일 뿐, 규칙 자체의 행동은 위 테스트가 잠근다)
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
test('App 배선: 카드·검색 화면은 순수 함수가 고른 키로 그리고, 개인 공간 이름·연결 상태는 한 곳에서 읽는다', () => {
  assert.match(app, /deliveryCardView\(\{ busy, job \}\)/);
  assert.match(app, /searchView\(\{ res, busy, total, phone \}\)/);
  assert.match(app, /crewOpeners\(\{ isPersonal, openSheet: setSheet, openDm: dmWithCrew \}\)/);
  assert.match(app, /creatorTagVisible\(\{ isCreator: channel\.created_by === m\.user_id, isPersonal, isGroup: !!channel\._personal_group \}\)/);
  assert.match(app, /fetchSelfName\(\(fn, args\) => q\(supabase\.rpc\(fn, args\)\), uid\)/);
  assert.match(app, /\{!online && <div className="msgr-offline-bar" role="status">\{t\('net\.offline'\)\}<\/div>\}/);
  assert.match(app, /setOnline\(navigator\.onLine !== false\); setResumeEpoch/, '앞으로 돌아올 때 연결 상태를 다시 읽는다');
});
