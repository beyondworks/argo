// 회사 단위 메신저 알림 목적지(설정 › Argo 메신저 연결 › 알림 받을 방) + Castra 실행 계약의 시스템 프롬프트 포함.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs'; // 종료 시 일괄 삭제(잔여물 실사고 규칙)
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-notify-')); // 격리 루트 — 실데이터·저장소 workspaces/ 미접촉(gateway.test.mjs 관례)
import { normalizeMsgrNotify, msgrNotifyWants, formatMsgrNotify, msgrNotifyCrewSlug, MSGR_NOTIFY_EVENTS } from '../src/msgr-notify.mjs';

const ORG = '11111111-1111-4111-8111-111111111111', CH = '22222222-2222-4222-8222-222222222222';

test('normalizeMsgrNotify — { mode:"dm" }만 켜짐, 옛 방 지정 형식·null·문자열은 끔(조용히 다른 방으로 가지 않음)', () => {
  assert.equal(normalizeMsgrNotify(null), null); assert.equal(normalizeMsgrNotify(undefined), null); assert.equal(normalizeMsgrNotify('dm'), null);
  assert.equal(normalizeMsgrNotify({ orgId: ORG, channelId: CH, events: ['job'] }), null, '옛 방 지정 형식은 무시');
  assert.deepEqual(normalizeMsgrNotify({ mode: 'dm', extra: 1 }), { mode: 'dm' });
  assert.ok(MSGR_NOTIFY_EVENTS.includes('approval') && MSGR_NOTIFY_EVENTS.includes('job'));
});

test('msgrNotifyWants — 켜짐 + 메신저가 받는 종류 + 음소거 아님, 루틴은 자기 목적지가 없을 때만', () => {
  const n = { mode: 'dm' };
  assert.equal(msgrNotifyWants(n, { type: 'job' }), true);
  assert.equal(msgrNotifyWants(n, { type: 'approval' }), true);
  assert.equal(msgrNotifyWants(n, { type: 'job' }, ['job']), false, '카드 칩(mutedEvents)이 종류별 세부');
  assert.equal(msgrNotifyWants(n, { type: 'nope' }), false);
  assert.equal(msgrNotifyWants(n, { type: 'routine', routine: { id: 'r' } }), true);
  assert.equal(msgrNotifyWants(n, { type: 'routine', routine: { id: 'r', notifications: { channels: [] } } }), false, '루틴 자기 목적지(#513)가 우선');
  assert.equal(msgrNotifyWants(null, { type: 'job' }), false);
  assert.equal(msgrNotifyWants({ orgId: ORG, channelId: CH, events: ['job'] }, { type: 'job' }), false, '정규화 안 거친 옛 형식도 끔');
});

test('formatMsgrNotify — 종류별 머리·이름 치환(slug 노출 없음)·ko/en', () => {
  const names = { alpha: '알파', beta: '베타' };
  assert.match(formatMsgrNotify({ type: 'crewmail', from: 'alpha', slug: 'beta', reply: '보고' }, 'ko', names), /^\[동료 쪽지\] 알파 → 베타\n\n보고$/);
  assert.match(formatMsgrNotify({ type: 'job', title: '긴 작업', ok: true, reply: '끝' }, 'ko'), /^\[장시간 작업 완료\] 긴 작업/);
  assert.match(formatMsgrNotify({ type: 'job', title: 'T', ok: false, reply: 'x' }, 'en'), /^\[Long task stopped\] T/);
  assert.match(formatMsgrNotify({ type: 'approval', item: { action: '메일 발송', reason: '고객 회신' } }, 'ko'), /^\[결재 요청\] 메일 발송\n고객 회신\n\(아르고 앱/);
  assert.match(formatMsgrNotify({ type: 'delegate', from: 'alpha', to: 'beta', task: '정리', reply: '완료' }, 'en', names), /^\[Delegation result\] 알파 → 베타: 정리/);
  assert.equal(formatMsgrNotify({ type: 'nope' }), '');
  assert.equal(msgrNotifyCrewSlug({ type: 'approval', item: { slug: 'a' } }), 'a');
  assert.equal(msgrNotifyCrewSlug({ type: 'routine', routine: { agentSlug: 'r' } }), 'r');
  assert.equal(msgrNotifyCrewSlug({ type: 'delegate', to: 'b' }), 'b');
  assert.equal(msgrNotifyCrewSlug({ type: 'job', slug: 'j' }), 'j');
});

test('pushEvent — 켜져 있을 때 원점 없는 이벤트만 간다(원점 있음·음소거·미설정·옛 형식은 호출 0), 배달 실패는 삼킨다', async () => {
  const { _pushEventForTest } = await import('../src/gateway.mjs');
  const { createCompany, loadCompany, updateCompany } = await import('../src/workspace.mjs');
  const ws = 'msgr-notify-dm';
  await createCompany(ws, '알림 검수', 'beta');
  const calls = [];
  const notifyMsgr = async (event, target) => { calls.push({ type: event.type, mode: target.mode }); return true; };
  const pushMsgr = async () => false;
  const job = { type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' };
  await _pushEventForTest(job, { pushMsgr, notifyMsgr });
  assert.deepEqual(calls, [], '미설정이면 가지 않는다');
  await updateCompany(ws, { msgr: { ...((await loadCompany(ws)).msgr ?? {}), notify: { orgId: ORG, channelId: CH, events: ['job'] } } });
  await _pushEventForTest(job, { pushMsgr, notifyMsgr });
  assert.deepEqual(calls, [], '옛 방 지정 형식은 끔');
  await updateCompany(ws, { msgr: { ...(await loadCompany(ws)).msgr, notify: { mode: 'dm' }, mutedEvents: ['approval'] } });
  await _pushEventForTest(job, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ ...job, msgr: { channelId: 'origin' } }, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ type: 'crewmail', wsId: ws, from: 'alpha', slug: 'beta', reply: '쪽지' }, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ type: 'approval', wsId: ws, item: { id: 'a1', slug: 'beta', action: 'x' } }, { pushMsgr, notifyMsgr });
  assert.deepEqual(calls, [{ type: 'job', mode: 'dm' }, { type: 'crewmail', mode: 'dm' }], '원점 있는 job과 음소거된 approval은 제외');
  const boom = async () => { throw new Error('room offline'); };
  await _pushEventForTest(job, { pushMsgr, notifyMsgr: boom }); // 던지지 않는다
});

test('시스템 프롬프트 — Castra 실행 계약이 ko/en 골격 모두에 안전 한계 앞에 들어가고, Castra 스크립트 이름은 없다(크루에게 없는 도구)', async () => {
  const { systemPromptFor, castraPosture } = await import('../src/chat.mjs');
  for (const lang of ['ko', 'en']) {
    const p = systemPromptFor('# 카드', '/tmp/ws', '', { name: '알파' }, lang);
    const at = p.indexOf('## Castra execution contract'); const safety = p.indexOf(lang === 'en' ? '## Safety limits' : '## 안전 한계');
    assert.ok(at > 0 && safety > at, `${lang}: Castra 절이 안전 한계 앞에`);
    assert.doesNotMatch(p, /castra_runtime\.py|castra_notes\.py|Stop guard|circuit breaker|worktrees|complete safety/, 'Argo 크루에 없는 Castra 도구·훅·워크트리를 지시하지 않고, 대본 답변(클라우드 안전)과 충돌하는 문장이 없다');
    for (const h of ['### Start from the user\'s result', '### Make checks capable of catching the defect', '### Stop on an evidenced outcome', '### Precedence']) assert.ok(p.includes(h), `${lang}: ${h}`);
    if (lang === 'ko') assert.match(p, /영어 원문이다\. 답변은 한국어로/, 'ko 골격이 castraPosture(\'ko\')를 넘긴다(배선 핀)'); else assert.doesNotMatch(p, /영어 원문/);
  }
  assert.ok(castraPosture('ko').length > 3000, '계약 본문'); assert.match(castraPosture('ko'), /^\(아래 실행 계약은 영어 원문이다/, 'ko 골격엔 언어 안내 한 줄'); assert.doesNotMatch(castraPosture('en'), /영어 원문/);
  process.env.ARGO_CASTRA = '0';
  try { assert.equal(castraPosture('ko'), '', 'ARGO_CASTRA=0 옵트아웃'); } finally { delete process.env.ARGO_CASTRA; }
});

/** 가짜 메신저 클라이언트 — 멤버십 조회·DM 생성 RPC만 흉내. 크루 beta는 두 조직에 파견(ORG는 1:1 방 있음, ORG2는 없음 → 생성). */
function fakeMsgr({ archived = false, thirdParty = false } = {}) {
  const ORG2 = '33333333-3333-4333-8333-333333333333';
  const crews = [
    { id: 'crew-beta', org_id: ORG, slug: 'beta', display_name: '베타' },
    { id: 'crew-beta-2', org_id: ORG2, slug: 'beta', display_name: '베타' },
    { id: 'crew-gamma', org_id: ORG, slug: 'gamma', display_name: '감마' },
  ];
  const rows = []; const seen = new Set(); const rpc = [];
  const members = { [CH]: [{ member_kind: 'crew', member_id: 'crew-beta' }, { member_kind: 'user', member_id: 'owner-1' }] };
  const channels = { [CH]: { kind: 'dm', archived_at: archived ? '2026-09-01T00:00:00Z' : null } };
  const SHARED = '44444444-4444-4444-8444-444444444444'; // 같은 조직의 다른 구성원 B가 내 크루와 연 DM = {크루, B, 나(소유자 동반)} — 정상 모양이지만 제3자가 읽는다
  if (thirdParty) { members[SHARED] = [{ member_kind: 'crew', member_id: 'crew-beta' }, { member_kind: 'user', member_id: 'user-B' }, { member_kind: 'user', member_id: 'owner-1' }]; channels[SHARED] = { kind: 'dm', archived_at: null }; }
  const db = {
    myCrews: async (uid, w) => (uid === 'owner-1' ? crews : []),
    crewChannels: async (crewId) => Object.keys(members).filter((id) => channels[id].kind === 'dm' && members[id].some((m) => m.member_kind === 'crew' && m.member_id === crewId)),
    insertMessage: async (row) => { rows.push(row); if (seen.has(row.client_msg_id)) return null; seen.add(row.client_msg_id); return { id: `m${rows.length}` }; },
  };
  const client = {
    from: (table) => {
      assert.equal(table, 'msgr_channel_members');
      const q = { ids: null, kind: null, member: null };
      const chain = {
        select: () => chain, in: (_col, ids) => { q.ids = ids; return chain; },
        eq: (col, v) => { if (col === 'member_kind') q.kind = v; else if (col === 'member_id') q.member = v; return chain; },
        then: (res) => res({ data: (q.ids ?? []).flatMap((id) => (members[id] ?? []).filter((m) => (!q.kind || m.member_kind === q.kind) && (!q.member || m.member_id === q.member)).map((m) => ({ channel_id: id, member_kind: m.member_kind, member_id: m.member_id, msgr_channels: { archived_at: channels[id].archived_at } }))), error: null }),
      };
      return chain;
    },
    rpc: async (fn, args) => { rpc.push({ fn, args }); const id = `new-${rpc.length}`; channels[id] = { kind: 'dm', archived_at: null }; members[id] = [{ member_kind: 'crew', member_id: args.others[0].id }, { member_kind: 'user', member_id: 'owner-1' }]; return { data: id, error: null }; },
  };
  return { session: async () => ({ uid: 'owner-1', db, client }), rows, rpc, ORG2, SHARED };
}

test('msgrNotifyPush(배달층) — 크루와 나의 1:1 방으로(있으면 재사용, 없는 조직은 dm 생성), 브리지 꺼짐 false, 크루 부재 false, 같은 이벤트 1회', async () => {
  const { msgrNotifyPush } = await import('../src/gateway/msgr.mjs');
  const { createCompany, loadCompany, updateCompany } = await import('../src/workspace.mjs');
  const ws = 'msgr-notify-deliver';
  await createCompany(ws, '배달 검수', 'beta', 'owner-1'); // 소유자 = 세션 계정(소유자 불일치·미기록은 배달하지 않는다)
  const { session, rows, rpc, ORG2 } = fakeMsgr();
  const ev = { type: 'job', wsId: ws, slug: 'beta', title: '긴 작업', ok: true, reply: '끝' };
  const at = Date.parse('2026-09-14T14:00:00Z');
  assert.equal(await msgrNotifyPush(ev, { mode: 'dm' }, { session, now: at }), false, '브리지 꺼짐(msgr.enabled 아님)이면 세션도 열지 않는다');
  await updateCompany(ws, { msgr: { ...((await loadCompany(ws)).msgr ?? {}), enabled: true } });
  assert.equal(await msgrNotifyPush(ev, { mode: 'dm' }, { session, now: at }), true);
  assert.equal(rows.length, 2, '파견된 두 조직 각각의 1:1 방');
  assert.deepEqual(rows.map((r) => r.channel_id), [CH, 'new-1'], 'ORG는 기존 1:1 방, ORG2는 새로 만든 방');
  assert.deepEqual(rpc, [{ fn: 'msgr_create_channel', args: { org: ORG2, kind: 'dm', name: 'dm:베타', others: [{ kind: 'crew', id: 'crew-beta-2' }] } }], '메신저 앱과 같은 RPC·인자');
  assert.deepEqual({ author_kind: rows[0].author_kind, crew_id: rows[0].crew_id, kind: rows[0].kind, mentions: rows[0].mentions, meta: rows[0].meta },
    { author_kind: 'crew', crew_id: 'crew-beta', kind: 'text', mentions: [], meta: { disposition: 'done', notification: 'job' } });
  assert.equal(rows[1].crew_id, 'crew-beta-2', '조직마다 그 조직의 크루 행으로');
  assert.match(rows[0].body, /^\[장시간 작업 완료\] 긴 작업\n\n끝$/); assert.match(rows[0].client_msg_id, /^nt:crew-beta:[0-9a-f]{32}$/);
  assert.equal(await msgrNotifyPush(ev, { mode: 'dm' }, { session, now: at + 5_000 }), false, '같은 이벤트 재배달(5초 뒤) = 같은 client_msg_id → 중복 삽입 없음');
  assert.equal(rpc.length, 1, '두 번째는 방금 만든 방을 재사용(생성 RPC 없음)');
  assert.equal(rows[2].client_msg_id, rows[0].client_msg_id);
  assert.equal(await msgrNotifyPush({ ...ev, reply: '끗' }, { mode: 'dm' }, { session, now: at }), true, '같은 길이·다른 본문은 다른 알림');
  assert.equal(await msgrNotifyPush(ev, { mode: 'dm' }, { session, now: at + 3_600_000 }), true, '다음 시간 버킷이면 새 알림(반복 루틴 유실 방지)');
  const before = rows.length;
  assert.equal(await msgrNotifyPush({ ...ev, slug: 'nobody' }, { mode: 'dm' }, { session, now: at }), false, '파견 안 된 크루 → false(다른 방·다른 이름으로 가지 않음)');
  assert.equal(rows.length, before);
  assert.equal(await msgrNotifyPush({ type: 'crewmail', wsId: ws, from: 'beta', slug: 'gamma', reply: '쪽지' }, { mode: 'dm' }, { session, now: at }), true, '수신 크루(감마)와의 1:1 방으로');
  assert.equal(rows.at(-1).crew_id, 'crew-gamma'); assert.equal(rows.at(-1).channel_id, 'new-2');
});

test('msgrNotifyPush — 보관한 1:1 방은 되살리지 않고 새 방을 만든다', async () => {
  const { msgrNotifyPush } = await import('../src/gateway/msgr.mjs');
  const { createCompany, loadCompany, updateCompany } = await import('../src/workspace.mjs');
  const ws = 'msgr-notify-archived';
  await createCompany(ws, '보관 검수', 'beta', 'owner-1'); // 소유자 = 세션 계정(소유자 불일치·미기록은 배달하지 않는다)
  await updateCompany(ws, { msgr: { ...((await loadCompany(ws)).msgr ?? {}), enabled: true } });
  const { session, rows, rpc } = fakeMsgr({ archived: true });
  assert.equal(await msgrNotifyPush({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { mode: 'dm' }, { session, now: 0 }), true);
  assert.equal(rpc.length, 2); assert.ok(rows.every((r) => r.channel_id !== CH), '보관된 방(CH)에는 올리지 않음');
});

test('msgrNotifyPush — 제3자가 든 DM({크루, B, 나})은 1:1이 아니다: 그 방에 올리지 않고 내 전용 방을 쓴다/만든다(검수 #537 HIGH-1)', async () => {
  const { msgrNotifyPush } = await import('../src/gateway/msgr.mjs');
  const { createCompany, loadCompany, updateCompany } = await import('../src/workspace.mjs');
  const ws = 'msgr-notify-third-party';
  await createCompany(ws, '제3자 검수', 'beta', 'owner-1'); // 소유자 = 세션 계정(소유자 불일치·미기록은 배달하지 않는다)
  await updateCompany(ws, { msgr: { ...((await loadCompany(ws)).msgr ?? {}), enabled: true } });
  const ev = { type: 'crewmail', wsId: ws, from: 'alpha', slug: 'beta', reply: '고객 단가 협상안 초안' };
  { // 내 전용 방(CH)과 제3자 방(SHARED)이 둘 다 있으면 행 순서와 무관하게 CH
    const { session, rows, rpc, SHARED } = fakeMsgr({ thirdParty: true });
    assert.equal(await msgrNotifyPush(ev, { mode: 'dm' }, { session, now: 0 }), true);
    assert.ok(rows.every((r) => r.channel_id !== SHARED), '제3자 방에 본문이 올라가지 않는다');
    assert.equal(rows.find((r) => r.crew_id === 'crew-beta').channel_id, CH);
    assert.equal(rpc.length, 1, 'ORG2만 생성(ORG는 기존 전용 방)');
  }
  { // 제3자 방만 있고(내 전용 방은 보관됨) → 새 전용 방 생성, 제3자 방은 절대 아님
    const { session, rows, rpc, SHARED } = fakeMsgr({ thirdParty: true, archived: true });
    assert.equal(await msgrNotifyPush(ev, { mode: 'dm' }, { session, now: 0 }), true);
    assert.ok(rows.every((r) => r.channel_id !== SHARED && r.channel_id !== CH));
    assert.equal(rpc.length, 2);
  }
});

test('notifyChannelState — 체크박스 정본: 연결됨은 실제 배달 조건, 켜짐은 연결됨+전부 음소거 아님(아르고 메신저는 notify mode dm)', async () => {
  const { notifyChannelState } = await import('../src/msgr-notify.mjs');
  const { CHANNEL_EVENTS } = await import('../src/channel-events.mjs');
  const base = { telegram: { enabled: false, token: 'x', chatId: null, agents: {}, mutedEvents: [] }, slack: { enabled: true, token: 'x', channel: '', mutedEvents: [] } };
  let st = notifyChannelState({ connections: base, company: { msgr: { enabled: true } }, signedIn: true });
  assert.deepEqual(st.telegram, { connected: false, on: false }, '토큰만 저장·중지(enabled false)면 배달이 없으니 연결 안 됨(검수 HIGH-3 거짓 양성)');
  assert.deepEqual(st.slack, { connected: false, on: false }, '채널 미설정이면 배달 불가');
  assert.deepEqual(st.msgr, { connected: true, on: false, signedIn: true });
  st = notifyChannelState({ connections: { ...base, telegram: { ...base.telegram, agents: { beta: { token: 'y', pairCode: 'ABC' } } } }, company: {}, signedIn: false });
  assert.deepEqual(st.telegram, { connected: false, on: false }, '토큰만 붙이고 페어링 전(ownerChat 없음)인 직통 봇은 배달이 없다(검수 2R MEDIUM-1)');
  st = notifyChannelState({ connections: { ...base, telegram: { ...base.telegram, agents: { beta: { token: 'y', ownerChat: '999' } } } }, company: {}, signedIn: false });
  assert.deepEqual(st.telegram, { connected: true, on: true }, '게이트웨이 없이 페어링된 크루 직통 봇만 있어도 브리핑을 받는다(거짓 음성 방지)');
  st = notifyChannelState({ connections: { ...base, telegram: { ...base.telegram, ownerId: 'A', agents: { beta: { token: 'y', ownerChat: '999', ownerId: 'B' } } } }, company: {}, signedIn: false });
  assert.deepEqual(st.telegram, { connected: false, on: false }, '게이트웨이 사장이 A인데 봇은 B가 페어링 → 배달 정본이 거절(2026-08-28 C4)');
  assert.deepEqual(st.msgr, { connected: false, on: false, signedIn: false });
  st = notifyChannelState({ connections: { telegram: { enabled: true, token: 'x', chatId: 1, mutedEvents: [...CHANNEL_EVENTS.telegram] }, slack: { enabled: true, token: 'x', channel: 'C1', mutedEvents: ['approval'] } }, company: { msgr: { enabled: false, notify: { mode: 'dm' } } }, signedIn: true });
  assert.deepEqual(st.telegram, { connected: true, on: false }, '전부 음소거 = 끔');
  assert.deepEqual(st.slack, { connected: true, on: false }, '옛 칩으로 일부만 음소거한 회사는 끔으로 보인다 — 체크 한 번이 전부 켠다(화면=실제)');
  assert.deepEqual(st.msgr, { connected: false, on: true, signedIn: true }, '파견 0인데 켜져 있음 → 카드가 해제만 허용(MEDIUM-3)');
  assert.deepEqual(notifyChannelState(), { msgr: { connected: false, on: false, signedIn: false }, telegram: { connected: false, on: false }, slack: { connected: false, on: false } });
});
