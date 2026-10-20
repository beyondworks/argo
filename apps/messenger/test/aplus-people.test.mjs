// 메신저 A+ 사람 탭(2026-10-20 유건: 사람 채팅까지 넣고 한 번에 공개) — 판단(people.mjs)·가짜 원본 행동·문구·요청 예산. 화면 캡처는 test/aplus.fixture.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { peopleErrorKey, peopleGate, nameProblem, roomRows, memberRows, canInvite, canCreateRoom, addFiles, canSend, formatBytes, fileIcon, attachmentsByMessage, legacyRoom, toUpload, NAME_MAX, LIMIT_DETAILS, createReadMarker } from '../src/aplus/people.mjs';
import { createFakeSource } from '../src/aplus/fake.mjs';
import { DICT } from '../src/i18n.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const err = (m) => Object.assign(new Error(m), { code: '42501' });

test('서버 판정이 최종: msgr2_pro_required → Pro 안내, lite 가드·없는 함수 → 아직 열리지 않음, 그 밖 → 다시 시도', () => {
  assert.equal(peopleGate(err('msgr2_pro_required')), 'pro');
  assert.equal(peopleGate(err('msgr2_lite_only')), 'closed');
  assert.equal(peopleGate({ code: 'PGRST202', message: 'Could not find the function' }), 'closed');
  assert.equal(peopleGate({ message: 'Failed to fetch' }), 'error');
  assert.equal(peopleErrorKey(err('msgr2_member_not_pro')), 'people.err.msgr2_member_not_pro', '무료 상대를 바로 넣기(1:1 열기·방에 넣기)');
  assert.equal(peopleErrorKey({ code: '22023', message: 'msgr2_limit', details: 'invites_day' }), 'people.limit.invites_day', '상한 = details별 문구');
  assert.equal(peopleErrorKey({ code: 'rejected', details: 'user_messages' }), 'people.limit.user_messages', '기계 보내기 결과(code rejected + detail)');
  assert.equal(peopleErrorKey({ code: '22023', message: 'msgr2_limit', details: 'new' }), 'people.limit.other');
  assert.equal(peopleErrorKey('invalid_attachment'), 'people.err.invalid_attachment');
  assert.equal(peopleErrorKey({ message: 'boom' }), null);
});

test('이름: 빈 이름·너무 긴 이름은 막는다', () => {
  assert.equal(nameProblem('  '), 'empty');
  assert.equal(nameProblem('x'.repeat(NAME_MAX + 1)), 'long');
  assert.equal(nameProblem('출시-준비'), null);
});

test('방 줄: 채널(open·private)과 사람 1:1(direct + 사람 상대)을 나누고, 에이전트 1:1·회의방은 뺀다', () => {
  const uid = 'me';
  const rooms = [
    { id: 'c2', kind: 'open', name: '출시' }, { id: 'c1', kind: 'private', name: '운영', archived_at: '2026-01-01' },
    { id: 'd1', kind: 'direct', last_at: '2026-10-20T01:00:00Z' }, { id: 'd2', kind: 'direct', last_at: '2026-10-20T03:00:00Z', legacy: true },
    { id: 'ad', kind: 'direct' }, { id: 'mt', kind: 'private', name: '회의', meeting: true },
  ];
  const members = [
    { room_id: 'c2', member_kind: 'user', member_id: 'me' }, { room_id: 'c2', member_kind: 'user', member_id: 'u1' }, { room_id: 'c2', member_kind: 'agent', member_id: 'a1' },
    { room_id: 'd1', member_kind: 'user', member_id: 'me' }, { room_id: 'd1', member_kind: 'user', member_id: 'u1' },
    { room_id: 'd2', member_kind: 'user', member_id: 'me' }, { room_id: 'd2', member_kind: 'user', member_id: 'u2' },
    { room_id: 'ad', member_kind: 'user', member_id: 'me' }, { room_id: 'ad', member_kind: 'agent', member_id: 'a1' },
  ];
  const { channels, dms } = roomRows({ rooms, members, uid, names: { u1: '김효원', u2: '박지민' } });
  assert.deepEqual(channels.map((r) => r.id), ['c1', 'c2'], '이름순(운영 < 출시)');
  assert.equal(channels[1].count, 2, '멤버 수는 사람만'); assert.equal(channels[0].private, true); assert.equal(channels[0].readOnly, true, '보관된 방은 읽기 전용');
  assert.deepEqual(dms.map((r) => [r.id, r.name]), [['d2', '박지민'], ['d1', '김효원']], '최근 대화 순, 에이전트 1:1(ad) 없음');
  assert.equal(dms[0].legacy, true);
});

test('멤버: 나 먼저, 역할순(관리자→운영진→멤버→손님), 빠졌거나 기한 지난 사람은 숨김', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const { humans, agents } = memberRows({ uid: 'me', now, people: [
    { user_id: 'g', name: '손님', role: 'guest' }, { user_id: 'me', name: '나', role: 'member' }, { user_id: 'o', name: '관리', role: 'owner' },
    { user_id: 'x', name: '빠짐', role: 'member', removed_at: '2026-10-01' }, { user_id: 'e', name: '만료', role: 'guest', expires_at: '2026-10-19T00:00:00Z' },
  ], agents: [{ id: 'a', display_name: '리서치', owner_user_id: 'me', status: 'paused' }, { id: 'r', display_name: '은퇴', status: 'retired' }] });
  assert.deepEqual(humans.map((h) => h.id), ['me', 'o', 'g']);
  assert.deepEqual(agents.map((a) => [a.id, a.mine, a.paused]), [['a', true, true]]);
});

test('권한: 초대는 owner·admin, 채널 만들기는 손님 제외, 개인 공간은 둘 다 아님', () => {
  assert.equal(canInvite({ role: 'owner' }), true); assert.equal(canInvite({ role: 'member' }), false); assert.equal(canInvite({ role: 'owner', personal: true }), false);
  assert.equal(canCreateRoom({ role: 'member' }), true); assert.equal(canCreateRoom({ role: 'guest' }), false); assert.equal(canCreateRoom(null), false);
});

test('첨부: 같은 파일은 한 번, 20개·50MB 넘으면 보내기 전에 막고 목록은 그대로, 첨부만 보낸 글도 된다', () => {
  const f = (name, bytes = 10) => ({ name, mime: 'text/plain', bytes, data: null });
  let r = addFiles([], [f('a.txt'), f('a.txt'), f('b.txt')]);
  assert.deepEqual(r.files.map((x) => x.name), ['a.txt', 'b.txt']); assert.equal(r.problem, null);
  const many = Array.from({ length: 20 }, (_, i) => f(`${i}.txt`));
  r = addFiles(many, [f('21.txt')]); assert.equal(r.problem, 'tooMany'); assert.equal(r.files.length, 20);
  r = addFiles([], [f('big.mov', 52_428_801)]); assert.equal(r.problem, 'tooBig'); assert.equal(r.files.length, 0);
  assert.equal(canSend({ body: '', files: [f('a')] }), true, '첨부만');
  assert.equal(canSend({ body: '  ', files: [] }), false);
  assert.equal(canSend({ body: 'hi', blocked: true }), false, '읽기 전용·막힘');
  assert.deepEqual(toUpload({ name: 'x.png', type: 'image/png', size: 5 }).bytes, 5);
});

test('읽음 표시(폭주 방지): 글 100개가 한꺼번에 와도 1회, 계속 와도 maxWait마다 1회, 작아지거나 같은 값은 보내지 않음', async () => {
  let now = 0; const q = []; const sent = [];
  const timers = { now: () => now, set: (fn, ms) => { const h = { fn, at: now + ms }; q.push(h); return h; }, clear: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); } };
  const advance = async (ms) => { const end = now + ms; for (;;) { q.sort((a, b) => a.at - b.at); const h = q[0]; if (!h || h.at > end) break; q.shift(); now = h.at; h.fn(); await Promise.resolve(); } now = end; await Promise.resolve(); };
  const r = createReadMarker({ send: async (id) => { sent.push(id); }, timers });
  for (let i = 1; i <= 100; i++) r.see(i); // 글 100개 받음
  await advance(3000); await Promise.resolve();
  assert.deepEqual(sent, [100], '100개 → 읽음 요청 1회');
  r.see(50); r.see(100); await advance(10_000); assert.deepEqual(sent, [100], '작거나 같은 값은 0회');
  for (let i = 0; i < 300; i++) { r.see(101 + i); await advance(2000); } // 2초마다 1개씩 10분 — 조용해지지 않아도
  assert.ok(sent.length - 1 <= 21, `10분 동안 계속 와도 ${sent.length - 1}회(30초마다 1회 이하)`);
  await advance(5000); assert.equal(sent.at(-1), 400, '마지막 값은 조용해지면 보낸다');
  const before = sent.length; await advance(600_000); assert.equal(sent.length, before, '그 뒤 10분 쉼 → 0회');
  r.see(1000); r.dispose(); await Promise.resolve(); assert.equal(sent.at(-1), 1000, '방을 닫으면 남은 것 1회'); r.see(2000); await advance(5000); assert.equal(sent.at(-1), 1000, '닫은 뒤 0회');
});

test('첨부 표시: 크기 문구·종류 아이콘·글별 묶음(같은 첨부는 한 번)', () => {
  assert.equal(formatBytes(512), '512 B'); assert.equal(formatBytes(240_120), '234.5 KB'); assert.equal(formatBytes(5_820_000), '5.6 MB');
  assert.equal(fileIcon({ mime: 'image/png' }), 'image'); assert.equal(fileIcon({ name: 'a.pdf' }), 'fpdf'); assert.equal(fileIcon({ name: 'x.xlsx' }), 'fsheet'); assert.equal(fileIcon({ name: 'z.bin' }), 'ffile');
  const by = attachmentsByMessage([{ id: 1, message_id: 7, name: 'a' }, { id: 1, message_id: 7, name: 'a' }, { id: 2, message_id: 8, name: 'b' }, { message_id: 'x' }]);
  assert.equal(by.get(7).length, 1); assert.equal(by.get(8).length, 1); assert.equal(by.size, 2);
});

test('옮겨 온 대화: 방 표지 또는 옮겨 온 글(meta.legacy_author) 하나라도 있으면', () => {
  assert.equal(legacyRoom({ legacy: true }), true);
  assert.equal(legacyRoom({}, [{ meta: { legacy_author: 'user' } }]), true);
  assert.equal(legacyRoom({}, [{ meta: {} }]), false);
});

test('가짜 원본: 첨부 보내기, 무료 상대 초대는 만들어지고 바로 넣기는 거부, 초대 수락은 공간 사건', async () => {
  const s = createFakeSource({ now: Date.now() });
  await s.send('ch-launch', '', [{ name: 'a.pdf', mime: 'application/pdf', bytes: 3 }]);
  assert.deepEqual(s.sent.at(-1).files, ['a.pdf']);
  assert.ok(await s.createInvite('sp-beyond', { userId: 'u-free' }), '무료 상대 초대 만들기는 된다(남의 요금제를 알리지 않음 — 수락 때 서버가 판정)');
  await assert.rejects(s.openUserDm('u-free', 'sp-beyond'), /msgr2_member_not_pro/, '무료 상대를 바로 넣는 경로는 거부');
  const seen = []; s.on('people', (e) => seen.push(e.event));
  const [inv] = await s.myInvites(); await s.acceptInvite(inv.code);
  assert.deepEqual(seen, ['spaces']); assert.equal((await s.myInvites()).length, 0);
  await assert.rejects(createFakeSource({ scenario: 'people-pro-lapsed' }).spaces(), /msgr2_pro_required/);
});

test('무료 계정: 사람 탭도 서버를 쓰지 않는다(plan 1회 뒤 start·spaces·myInvites 0) — 화면이 FreeGate에서 멈춘다', () => {
  const ui = read('../src/aplus/APlusApp.jsx');
  assert.match(ui, /if \(access === 'free'\) return <FreeGate/);
  assert.ok(ui.indexOf("if (access === 'free')") < ui.indexOf('<Workspace'), 'usePeople은 Workspace(Pro) 안에서만');
  assert.match(read('../src/aplus/People.jsx'), /if \(active && !started\.current\)/, '사람 탭을 열기 전에는 읽지 않는다');
});

test('문구: 사람 탭이 쓰는 people.* 키는 사전에 ko·en 둘 다 있다', () => {
  const src = read('../src/aplus/People.jsx') + read('../src/aplus/APlusApp.jsx');
  const fixed = [...src.matchAll(/'(people\.[a-zA-Z0-9.]+|aplus\.(?:tab|empty)\.people)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.'));
  const built = [...['owner', 'admin', 'member', 'guest'].map((r) => `people.role.${r}`), ...['tooMany', 'tooBig', 'bad'].map((k) => `people.file.${k}`), ...[...LIMIT_DETAILS, 'other'].map((k) => `people.limit.${k}`),
    ...['msgr2_pro_required', 'msgr2_member_not_pro', 'msgr2_lite_only', 'msgr2_invite_not_found', 'msgr2_invite_rejoin_direct_only', 'msgr2_dm_blocked', 'invalid_attachment'].map((c) => `people.err.${c}`)];
  const missing = [...new Set([...fixed, ...built])].filter((k) => !Array.isArray(DICT[k]) || !DICT[k][0] || !DICT[k][1]);
  assert.deepEqual(missing, []);
  assert.ok(fixed.length > 60, `고정 키 ${fixed.length}개`);
  assert.doesNotMatch(read('../src/aplus/People.jsx').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), /[가-힣]/, '화면 원본에 한글 문구 없음(사전만)');
});

test('쉬는 동안 요청 0·금지 장치: 사람 탭에도 주기 조회·window.confirm/prompt가 없다', () => {
  for (const f of ['../src/aplus/People.jsx', '../src/aplus/people.mjs']) { const s = read(f); assert.doesNotMatch(s, /setInterval/, f); assert.doesNotMatch(s, /window\.(confirm|prompt)/, f); }
});

test('A+ 화면 파일은 문법이 맞다(JSX 변환) — 노드 시험은 .jsx를 불러오지 않아 빌드 전에는 문법 오류를 못 잡았다', async () => {
  const { transform } = await import('esbuild');
  for (const f of ['../src/aplus/APlusApp.jsx', '../src/aplus/People.jsx']) await transform(read(f), { loader: 'jsx', jsx: 'automatic' }); // 오류면 던진다
});
