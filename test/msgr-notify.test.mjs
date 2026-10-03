// 회사 단위 메신저 알림 목적지(설정 › Argo 메신저 연결 › 알림 받을 방) + Castra 실행 계약의 시스템 프롬프트 포함.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs'; // 종료 시 일괄 삭제(잔여물 실사고 규칙)
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-notify-')); // 격리 루트 — 실데이터·저장소 workspaces/ 미접촉(gateway.test.mjs 관례)
// 동적 import — msgr-notify.mjs가 이제 approvals.mjs(→workspace.mjs)를 물고 있어(분리 검수 M-3),
// 정적 import면 ES 모듈 그래프가 위 ARGO_ROOT 대입보다 먼저 workspace.mjs의 WS_ROOT를 확정해 버린다
// (gateway.test.mjs 관례와 같은 이유 — "WS_ROOT는 모듈 로드 시 확정되므로 import보다 먼저 심는다").
const { normalizeMsgrNotify, msgrNotifyWants, formatMsgrNotify, msgrNotifyCrewSlug, MSGR_NOTIFY_EVENTS } = await import('../src/msgr-notify.mjs');

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

// 분리 검수 M-3 — 주인·크루 1:1 알림도 다른 창구(텔레그램·슬랙·메신저 카드 본문)와 같은 규칙: plain 있으면
// 그 문장 + "명령: <action>" 한 줄, 없으면(폴백) 기존 action/사유 그대로.
test('formatMsgrNotify — approval: plain 있으면 쉬운 문장 + "명령: <action>" 한 줄, 없으면(폴백) 기존 그대로', () => {
  const withPlain = { type: 'approval', item: { action: 'sendGmail(to=subs@list)', reason: 'CEO 지시',
    plain: { purpose: '뉴스레터 발송 완료', task: '구독자 발송', need: 'Gmail 권한' } } };
  const ko = formatMsgrNotify(withPlain, 'ko');
  assert.match(ko, /할 일: 구독자 발송/, '쉬운 문장이 먼저 보인다');
  assert.match(ko, /명령: sendGmail\(to=subs@list\)/, 'H-1: plain이 있어도 실제 실행될 명령이 보인다');
  const en = formatMsgrNotify(withPlain, 'en');
  assert.match(en, /Task: 구독자 발송/);
  assert.match(en, /Command: sendGmail\(to=subs@list\)/);
  // 폴백 — plain 없으면 회귀 없이 기존 그대로(위 종류별 테스트가 이미 잠근 계약과 동일한 문자열)
  const fallback = formatMsgrNotify({ type: 'approval', item: { action: '메일 발송', reason: '고객 회신' } }, 'ko');
  assert.match(fallback, /^\[결재 요청\] 메일 발송\n고객 회신\n\(아르고 앱/);
  assert.doesNotMatch(fallback, /명령:/, '폴백은 새 "명령:" 줄을 붙이지 않는다');
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

test('시스템 프롬프트 — lean-forge 계약 하나만 ko/en 안전 한계 앞에 주입한다', async () => {
  const { systemPromptFor } = await import('../src/chat.mjs');
  for (const lang of ['ko', 'en']) {
    const p = systemPromptFor('# 카드', '/tmp/ws', '', { name: '알파' }, lang);
    const at = p.indexOf('## lean-forge execution contract'); const safety = p.indexOf(lang === 'en' ? '## Safety limits' : '## 안전 한계');
    assert.ok(at > 0 && safety > at, `${lang}: lean-forge 절이 안전 한계 앞에`);
    assert.equal(p.split('## lean-forge execution contract').length - 1, 1);
    assert.doesNotMatch(p, /## Castra execution contract/);
    assert.doesNotMatch(p, /castra_runtime\.py|castra_notes\.py|Stop guard|circuit breaker|worktrees|complete safety/, 'Argo 크루에 없는 Castra 도구·훅·워크트리를 지시하지 않고, 대본 답변(클라우드 안전)과 충돌하는 문장이 없다');
    for (const h of ['### SETTLE', '### BUILD', '### PROVE', '### REPORT']) assert.ok(p.includes(h), `${lang}: ${h}`);
    if (lang === 'ko') assert.match(p, /영어 원문이다\. 답변은 한국어로/); else assert.doesNotMatch(p, /영어 원문/);
  }
  const previous = process.env.ARGO_LEAN_FORGE;
  process.env.ARGO_LEAN_FORGE = '0';
  try {
    for (const lang of ['ko', 'en']) {
      const p = systemPromptFor('# 카드', '/tmp/ws', '', { name: '알파' }, lang);
      assert.doesNotMatch(p, /## lean-forge execution contract|## Castra execution contract/);
      assert.ok(p.includes(lang === 'en' ? '## Safety limits' : '## 안전 한계'));
    }
  } finally {
    if (previous === undefined) delete process.env.ARGO_LEAN_FORGE;
    else process.env.ARGO_LEAN_FORGE = previous;
  }
});

/** 가짜 메신저 클라이언트 — 멤버십 조회·DM 생성 RPC만 흉내. 크루 beta는 두 조직에 파견(ORG는 1:1 방 있음, ORG2는 없음 → 생성).
    personal: 그 slug의 개인 행(org 없음)을 더한다 — 개인 1:1 방 RPC(msgr_dm_personal_crew)는 personalRpc대로 'ok'(방 PCH)·'error'(서버 거절)·'throw'(연결 실패).
    orgs: false면 조직 행 없이 개인 행만. counts: 조직 1:1 경로를 탔는지(crewChannels·멤버십 조회 횟수). */
function fakeMsgr({ archived = false, thirdParty = false, personal = null, personalRpc = 'ok', orgs = true } = {}) {
  const ORG2 = '33333333-3333-4333-8333-333333333333';
  const PCH = '55555555-5555-4555-8555-555555555555'; // 개인 공간의 크루 1:1 방(personal_pair crew:<id>)
  const crews = [
    ...(orgs ? [
      { id: 'crew-beta', org_id: ORG, slug: 'beta', display_name: '베타' },
      { id: 'crew-beta-2', org_id: ORG2, slug: 'beta', display_name: '베타' },
      { id: 'crew-gamma', org_id: ORG, slug: 'gamma', display_name: '감마' },
    ] : []),
    ...(personal ? [{ id: `crew-${personal}-p`, org_id: null, slug: personal, display_name: '개인 행' }] : []),
  ];
  const rows = []; const seen = new Set(); const rpc = []; const counts = { crewChannels: 0, from: 0 };
  const members = { [CH]: [{ member_kind: 'crew', member_id: 'crew-beta' }, { member_kind: 'user', member_id: 'owner-1' }] };
  const channels = { [CH]: { kind: 'dm', archived_at: archived ? '2026-09-01T00:00:00Z' : null } };
  const SHARED = '44444444-4444-4444-8444-444444444444'; // 같은 조직의 다른 구성원 B가 내 크루와 연 DM = {크루, B, 나(소유자 동반)} — 정상 모양이지만 제3자가 읽는다
  if (thirdParty) { members[SHARED] = [{ member_kind: 'crew', member_id: 'crew-beta' }, { member_kind: 'user', member_id: 'user-B' }, { member_kind: 'user', member_id: 'owner-1' }]; channels[SHARED] = { kind: 'dm', archived_at: null }; }
  const db = {
    myCrews: async (uid, w) => (uid === 'owner-1' ? crews : []),
    crewChannels: async (crewId) => { counts.crewChannels++; return Object.keys(members).filter((id) => channels[id].kind === 'dm' && members[id].some((m) => m.member_kind === 'crew' && m.member_id === crewId)); },
    insertMessage: async (row) => { rows.push(row); if (seen.has(row.client_msg_id)) return null; seen.add(row.client_msg_id); return { id: `m${rows.length}` }; },
  };
  const client = {
    from: (table) => {
      counts.from++;
      assert.equal(table, 'msgr_channel_members');
      const q = { ids: null, kind: null, member: null };
      const chain = {
        select: () => chain, in: (_col, ids) => { q.ids = ids; return chain; },
        eq: (col, v) => { if (col === 'member_kind') q.kind = v; else if (col === 'member_id') q.member = v; return chain; },
        then: (res) => res({ data: (q.ids ?? []).flatMap((id) => (members[id] ?? []).filter((m) => (!q.kind || m.member_kind === q.kind) && (!q.member || m.member_id === q.member)).map((m) => ({ channel_id: id, member_kind: m.member_kind, member_id: m.member_id, msgr_channels: { archived_at: channels[id].archived_at } }))), error: null }),
      };
      return chain;
    },
    rpc: async (fn, args) => {
      rpc.push({ fn, args });
      if (fn === 'msgr_dm_personal_crew') { // 서버: 주인·개인 행·활성만, 한 크루 한 방
        if (personalRpc === 'throw') throw new TypeError('fetch failed');
        if (personalRpc === 'error' || !crews.some((c) => c.id === args.crew && c.org_id == null)) return { data: null, error: { code: '22023', message: 'msgr_bad_member' } };
        channels[PCH] = { kind: 'dm', archived_at: null }; members[PCH] = [{ member_kind: 'user', member_id: 'owner-1' }, { member_kind: 'crew', member_id: args.crew }];
        return { data: PCH, error: null };
      }
      assert.equal(fn, 'msgr_create_channel');
      const id = `new-${rpc.length}`; channels[id] = { kind: 'dm', archived_at: null }; members[id] = [{ member_kind: 'crew', member_id: args.others[0].id }, { member_kind: 'user', member_id: 'owner-1' }]; return { data: id, error: null };
    },
  };
  return { session: async () => ({ uid: 'owner-1', db, client }), rows, rpc, counts, ORG2, SHARED, PCH };
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

// 에이전트 = 한 사람(유건 2026-10-03, P2) — 1:1은 개인 공간의 방 하나. 본체 알림도 그 방 하나로(조직마다 따로 올리지 않는다).
async function notifyWs(ws) {
  const { createCompany, loadCompany, updateCompany } = await import('../src/workspace.mjs');
  await createCompany(ws, '개인 방 검수', 'beta', 'owner-1');
  await updateCompany(ws, { msgr: { ...((await loadCompany(ws)).msgr ?? {}), enabled: true } });
}
test('msgrNotifyPush — 개인 행이 있으면 개인 1:1 방 하나에만 한 번(조직 1:1 조회·생성·게시 0), 같은 이벤트는 한 번만', async () => {
  const { msgrNotifyPush } = await import('../src/gateway/msgr.mjs');
  const ws = 'msgr-notify-personal'; await notifyWs(ws);
  const f = fakeMsgr({ personal: 'beta' });
  const ev = { type: 'job', wsId: ws, slug: 'beta', title: '긴 작업', ok: true, reply: '끝' };
  assert.equal(await msgrNotifyPush(ev, { mode: 'dm' }, { session: f.session, now: 0 }), true);
  assert.equal(f.rows.length, 1, '두 조직에 파견돼 있어도 개인 방 한 곳에 한 번');
  const [r] = f.rows;
  assert.deepEqual({ channel_id: r.channel_id, crew_id: r.crew_id, author_kind: r.author_kind, kind: r.kind, reply_to: r.reply_to, thread_root: r.thread_root, mentions: r.mentions, meta: r.meta },
    { channel_id: f.PCH, crew_id: 'crew-beta-p', author_kind: 'crew', kind: 'text', reply_to: null, thread_root: null, mentions: [], meta: { disposition: 'done', notification: 'job' } }, '개인 행 이름으로, 서버 자격 게이트의 nt: 모양 그대로');
  assert.match(r.client_msg_id, /^nt:crew-beta-p:[0-9a-f]{32}$/, '중복 방지 키 규칙은 그대로(크루 id 접두 + 해시)');
  assert.match(r.body, /^\[장시간 작업 완료\] 긴 작업\n\n끝$/);
  assert.deepEqual(f.rpc, [{ fn: 'msgr_dm_personal_crew', args: { crew: 'crew-beta-p' } }], '앱이 여는 방과 같은 RPC·인자, 조직 dm 생성 없음');
  assert.deepEqual(f.counts, { crewChannels: 0, from: 0 }, '조직 1:1 방을 찾지도 않는다');
  assert.equal(await msgrNotifyPush(ev, { mode: 'dm' }, { session: f.session, now: 5_000 }), false, '같은 이벤트 재배달 = 같은 방·같은 client_msg_id → 중복 삽입 없음');
  assert.deepEqual([f.rows[1].channel_id, f.rows[1].client_msg_id], [f.PCH, r.client_msg_id]);
  assert.equal(f.rpc.filter((x) => x.fn === 'msgr_create_channel').length, 0);
});

test('msgrNotifyPush — 개인 1:1 방을 열지 못하면(서버 거절·연결 실패) 종전 조직별 1:1로 보내 알림을 잃지 않는다', async () => {
  const { msgrNotifyPush } = await import('../src/gateway/msgr.mjs');
  const ws = 'msgr-notify-personal-fallback'; await notifyWs(ws);
  for (const personalRpc of ['error', 'throw']) {
    const f = fakeMsgr({ personal: 'beta', personalRpc });
    assert.equal(await msgrNotifyPush({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { mode: 'dm' }, { session: f.session, now: 0 }), true, personalRpc);
    assert.deepEqual(f.rows.map((x) => x.crew_id), ['crew-beta', 'crew-beta-2'], `${personalRpc}: 조직마다 그 조직의 크루 행으로(종전과 같다)`);
    assert.equal(f.rows[0].channel_id, CH, `${personalRpc}: ORG는 기존 1:1 방`);
    assert.ok(f.rows.every((x) => x.channel_id !== f.PCH));
    assert.deepEqual(f.rpc.map((x) => x.fn), ['msgr_dm_personal_crew', 'msgr_create_channel'], `${personalRpc}: 개인 방 시도 한 번 뒤 조직 경로(ORG2는 생성)`);
  }
});

test('msgrNotifyPush — 조직에 파견되지 않았어도 개인 행이 있으면 개인 1:1로, 다른 에이전트(slug)의 개인 행으로는 보내지 않는다', async () => {
  const { msgrNotifyPush } = await import('../src/gateway/msgr.mjs');
  const ws = 'msgr-notify-personal-only'; await notifyWs(ws);
  const solo = fakeMsgr({ personal: 'beta', orgs: false });
  assert.equal(await msgrNotifyPush({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { mode: 'dm' }, { session: solo.session, now: 0 }), true, '조직 0곳 + 개인 행 → 개인 방');
  assert.deepEqual(solo.rows.map((x) => [x.channel_id, x.crew_id]), [[solo.PCH, 'crew-beta-p']]);
  const other = fakeMsgr({ personal: 'gamma' });
  assert.equal(await msgrNotifyPush({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { mode: 'dm' }, { session: other.session, now: 0 }), true);
  assert.deepEqual(other.rows.map((x) => x.crew_id), ['crew-beta', 'crew-beta-2'], '감마의 개인 행은 베타 알림의 목적지가 아니다 → 베타는 종전 조직 경로');
  assert.equal(other.rpc.filter((x) => x.fn === 'msgr_dm_personal_crew').length, 0);
  const none = fakeMsgr({ personal: 'gamma', orgs: false });
  assert.equal(await msgrNotifyPush({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { mode: 'dm' }, { session: none.session, now: 0 }), false, '베타의 행이 하나도 없으면 false(다른 방·다른 이름으로 가지 않음)');
  assert.equal(none.rows.length, 0);
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
