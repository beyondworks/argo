// #793 독립 검수 반영(2026-10-01) — 원인별 검색 실패 문구, 첨부 실패 카드, 카드·검색 화면 선택 규칙, 개인 공간 내 이름 조회, 연결 상태 재확인.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createComposerDelivery, setDeliveryReporter } from '../src/composer-delivery.mjs';
import { fetchSearchRows } from '../src/search-rows.mjs';
import { searchView } from '../src/search-view.mjs';
import { deliveryCardView } from '../src/delivery-card.mjs';
import { resolvePeopleNames } from '../src/person-names.mjs';
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

test('개인 공간 내 이름: 사람 이름 한 길(resolvePeopleNames, 조직 없음) — msgr_people_names를 한 번에 묻고, 나만 묻는 호출을 따로 두지 않는다', async () => {
  const calls = [];
  const sb = { rpc: async (fn, args) => { calls.push([fn, args]); return { data: [{ user_id: 'me', name: '유건' }, { user_id: 'f1', name: '하나' }], error: null }; } };
  assert.deepEqual(await resolvePeopleNames(sb, { orgId: null, ids: ['me', 'f1', 'me'] }), { me: '유건', f1: '하나' });
  assert.deepEqual(calls, [['msgr_people_names', { ids: ['me', 'f1'] }]], '같은 id는 한 번, 다른 id와 한 번에');
  const old = { rpc: async () => ({ error: { message: 'Could not find the function' } }), from: () => ({ select: () => ({ in: async () => ({ data: [{ user_id: 'me', display_name: '유건' }] }) }) }) };
  assert.deepEqual(await resolvePeopleNames(old, { orgId: null, ids: ['me'] }), { me: '유건' }, '옛 서버는 프로필 이름으로');
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

test('#795 첨부 순서(글 먼저·전부 실패하면 삭제)와 #793 카드(원인별 문구·파일 이름)가 함께 동작한다', async () => {
  const reported = []; setDeliveryReporter((...a) => reported.push(a));
  try {
    const discarded = [];
    const mk = (over) => transport({ discard: async (job) => { discarded.push(job.messageId); }, ...over });
    // 첨부만 보낸 글이 전부 네트워크 오류로 실패 → 글은 지워지고(messageId null, 새 고정 ID), 카드는 '연결이 끊겨 보내지 못했습니다'(제목만, 줄 없음)
    const off = createComposerDelivery(mk({ upload: async () => { throw new TypeError('Failed to fetch'); } }), (() => { let n = 0; return () => `id${n++}`; })());
    off.setFiles([file('a.txt'), file('b.txt')]); assert.equal(await off.send([]), false);
    let job = off.snapshot().job;
    assert.deepEqual(discarded, [7], '빈 글을 지웠다');
    assert.equal(job.messageId, null); assert.equal(job.errorKey, 'msg.delivery.offline');
    assert.deepEqual(deliveryCardView({ busy: false, job }), { titleKey: 'msg.delivery.offline', errorLine: null , canRetry: true });
    assert.equal(reported.length, 1);
    // 글을 지우지 못하면 글은 남고 → 카드는 '일부 첨부 실패' + 이유 + 실패한 파일 이름
    const keep = createComposerDelivery(mk({ discard: async () => { throw new Error('no'); }, upload: async () => { throw new TypeError('Load failed'); } }));
    keep.setFiles([file('a.txt')]); await keep.send([]);
    job = keep.snapshot().job;
    assert.equal(job.messageId, 7);
    assert.deepEqual(deliveryCardView({ busy: false, job }), { titleKey: 'msg.delivery.attachFailed', errorLine: { key: 'msg.delivery.offline', raw: null, files: ['a.txt'] } , canRetry: true });
    // 네트워크가 아닌 실패(서버 거절)는 원문 줄 + 지운 글이므로 '전송 실패' 제목
    const srv = createComposerDelivery(mk({ upload: async () => { throw new Error('new row violates row-level security policy'); } }));
    srv.setFiles([file('c.txt')]); await srv.send([]);
    job = srv.snapshot().job;
    assert.deepEqual([job.messageId, job.errorKey], [null, '']);
    assert.deepEqual(deliveryCardView({ busy: false, job }), { titleKey: 'msg.delivery.failed', errorLine: { key: null, raw: 'c.txt: new row violates row-level security policy', files: [] } , canRetry: true });
  } finally { setDeliveryReporter(null); }
});

// 화면 배선 — 순수 함수를 App이 실제로 부르고 그 결과를 화면에 쓰는지(소스 확인은 보조일 뿐, 규칙 자체의 행동은 위 테스트가 잠근다).
// 부르기만 하고 결과를 안 쓰는 변이(예: onCrew={setSheet}로 되돌리기, t('msg.delivery.failed') 고정)도 여기서 잡는다.
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const has = (re, why) => assert.match(app, re, why);
test('App 배선 — 카드: 순수 함수 결과(제목·오류 줄)를 그린다', () => {
  has(/const card = job \? deliveryCardView\(\{ busy, job, isDm \}\) : null;/, '카드 선택은 순수 함수(1:1이면 영구 거절 문구가 다르다, D14)');
  has(/\{card\.canRetry && <button type="button" className="btn" disabled=\{locked \|\| retryBlocked\}/, '영구 거절이면 다시 보내기를 그리지 않는다(D14)');
  has(/<strong>\{t\(card\.titleKey\)\}<\/strong>/, '제목은 card.titleKey');
  has(/\{card\.errorLine && <p className="delivery-error">\{card\.errorLine\.key \? t\(card\.errorLine\.key\) : friendlyErr\(card\.errorLine\.raw, t\)\}\{card\.errorLine\.files\.length > 0 && ` · \$\{card\.errorLine\.files\.join\(', '\)\}`\}<\/p>\}/, '오류 줄은 card.errorLine(키 → 번역, 없으면 원문, 파일 이름)');
});
test('App 배선 — 검색: searchView 결과로 안내를 그리고, 조회 중·실패 상태를 넘긴다', () => {
  has(/const view = searchView\(\{ res, busy, total, phone \}\);/, '안내 선택은 순수 함수');
  has(/\{view\.loading && <p className="empty" role="status">\{t\('ui\.loading'\)\}<\/p>\}/, '조회 중');
  has(/\{view\.hintKey && <p className="empty">\{t\(view\.hintKey\)\}<\/p>\}/, '첫 안내');
  has(/\{view\.noticeKey && <p className="note danger" role="alert">\{t\(view\.noticeKey\)\}<\/p>\}/, '실패 안내');
  has(/\{view\.noneKey && <p className="empty">\{t\(view\.noneKey\)\}<\/p>\}/, '결과 없음');
  has(/const \{ msgs, more, failed \} = await fetchSearchRows\(/, '조회 실패는 failed로');
  has(/setSearchRes\(\{ q: qs, msgs, more, failed,/, 'failed를 결과에 담는다');
  has(/<SearchPage res=\{searchRes\} busy=\{searchBusy\}/, '조회 중 상태를 넘긴다');
});
test('App 배선 — 개인 공간: 에이전트 카드 열기·방장 표식·내 이름', () => {
  has(/const openers = crewOpeners\(\{ isPersonal, openSheet: setSheet, openDm: dmWithCrew \}\);/, '열기 규칙은 순수 함수');
  has(/onCrew=\{openers\.channel\} onTitle=/, '대화방 메시지의 에이전트 버튼');
  has(/onCrew=\{openers\.search\} onDm=/, '검색 결과의 에이전트');
  has(/isCrew && crew && onCrew \? <button type="button" className="msgr-avbtn" onClick=\{\(\) => onCrew\(crew\.id\)\}/, 'onCrew가 없으면 아바타 버튼을 그리지 않는다');
  has(/isCrew && crew && onCrew \? <button type="button" className="msgr-namebtn" onClick=\{\(\) => onCrew\(crew\.id\)\}>/, 'onCrew가 없으면 이름 버튼을 그리지 않는다');
  has(/const isCreator = creatorTagVisible\(\{ isCreator: channel\.created_by === m\.user_id, isPersonal, isGroup: !!channel\._personal_group \}\);/, '방장 표식 규칙');
  has(/\{\(isChAdmin \|\| isCreator\) && <span className="msgr-tag">\{isCreator \? t\('ch\.admin\.creator'\) : t\('ch\.admin'\)\}<\/span>\}/, '표식은 isCreator로 그린다');
  has(/const askName = \(id, force = false\) => \{/, '이름은 한 묶음 조회 길(askName → flushNames)로만 묻는다');
  has(/useEffect\(\(\) => \{ if \(isPersonal && uid\) askName\(uid\); \}, \[orgId, isPersonal, uid\]\);/, '개인 공간에 들어갈 때 내 id를 같은 묶음에 얹는다(주기 호출 아님)');
  assert.ok(app.indexOf('askName(uid); }, [orgId, isPersonal, uid]') > app.indexOf('nameAsked.current = new Set(); nameWanted.current = new Set(); setResolvedNames({});'), '조직 전환 비우기 효과 뒤에 선언해야 비운 뒤 다시 묻는다');
  has(/personalName: resolvedNames\[uid\] \|\| personalSelfName\(otherNames, uid\)/, '조회한 이름이 우선, 방 목록 이름이 대체');
  assert.doesNotMatch(app, /fetchSelfName|loadSelfName/, '내 이름만 따로 묻는 길은 없다(같은 RPC 두 번 방지)');
  has(/onProfileSaved=\{\(\) => \{ askName\(uid, true\); setProfileTick\(\(x\) => x \+ 1\); \}\}/, '프로필 저장 뒤 지우고 다시 묻는다(폰 설정 \'개인\' 줄 이름도 다시 읽는다)');
  has(/<Settings [^\n]*?session=\{session\} me=\{me\} uid=\{uid\} onAvatar=\{\(\) => \{ avatarAsked\.current\.delete\(uid\); loadAvatars\(\); \}\} onProfileSaved=/, '프로필 저장 뒤 다시 읽기 연결(내 사진은 이미 물어봤어도 다시)');
  has(/<ProfileCard uid=\{uid\} onNote=\{onNote\} onError=\{onError\} onAvatar=\{onAvatar\} onSaved=\{onProfileSaved\} \/>/, 'ProfileCard에 전달');
  has(/setP\(res\.data\); onNote\(t\('profile\.saved'\)\); onSaved\?\.\(\);/, '저장 성공 뒤 호출');
});
test('App 배선 — 연결 끊김: 감시 결과를 상태로 받고 막대를 그리며, 앞으로 돌아올 때 다시 읽는다', () => {
  has(/const \[online, setOnline\] = useState\(true\); useEffect\(\(\) => watchOnline\(setOnline\), \[\]\);/, '감시 결과 → online 상태');
  has(/\$\{online \? '' : ' is-offline'\}/, '끊기면 셸에 is-offline');
  has(/\{!online && <div className="msgr-offline-bar" role="status">\{t\('net\.offline'\)\}<\/div>\}/, '막대');
  has(/observeMobileResume\(\(\) => \{ setOnline\(navigator\.onLine !== false\); setResumeEpoch/, '앞으로 돌아올 때 재확인');
});
test('App 배선 — 일반: 에이전트 꺼짐 안내·대기 요청 안내·검색 아이콘·단축키', () => {
  has(/crewAwayNotice\(\{ channel, chCrews, people, uid, now: Date\.now\(\), awayMs: AWAY_MS \}\)/, '꺼짐 안내 판정');
  has(/crewListEmptyKey\(\{ crewCount: chCrews\.length, pendingCount: joinReqs\.length, isPersonal, canAddCrew, scoped \}\)/, '대기 요청 수를 넘긴다');
  has(/placeholder=\{t\('search\.ph', \{ key: shortcutLabel\('K'\) \}\)\}/, '단축키는 OS에 맞춰');
});

test('deliveryCardView: 영구 거절 — 1:1은 "보낼 수 없는 상대입니다", 채널은 "이 방에 보낼 수 없습니다", 둘 다 다시 보내기 없음(기능 점검 D14)', () => {
  const job = { messageId: null, error: 'new row violates row-level security policy', errorKey: 'msg.delivery.rejected', permanent: true, files: [] };
  assert.deepEqual(deliveryCardView({ busy: false, job, isDm: true }), { titleKey: 'msg.delivery.notSent', errorLine: { key: 'msg.delivery.unreachable', raw: null, files: [] }, canRetry: false }); // 제목이 '다시 시도해 주세요'면 안 된다
  assert.deepEqual(deliveryCardView({ busy: false, job, isDm: false }).errorLine.key, 'msg.delivery.rejected');
  assert.equal(deliveryCardView({ busy: false, job: { ...job, permanent: false, errorKey: '' } }).canRetry, true);
});
