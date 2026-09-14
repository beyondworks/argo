// 회사 단위 메신저 알림 목적지(설정 › Argo 메신저 연결 › 알림 받을 방) + Castra 실행 계약의 시스템 프롬프트 포함.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs'; // 종료 시 일괄 삭제(잔여물 실사고 규칙)
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-notify-')); // 격리 루트 — 실데이터·저장소 workspaces/ 미접촉(gateway.test.mjs 관례)
import { normalizeMsgrNotify, msgrNotifyWants, formatMsgrNotify, msgrNotifyCrewSlug, MSGR_NOTIFY_EVENTS } from '../src/msgr-notify.mjs';

const ORG = '11111111-1111-4111-8111-111111111111', CH = '22222222-2222-4222-8222-222222222222';

test('normalizeMsgrNotify — 끔은 null, 잘못된 id는 던짐, 이벤트는 목록 밖·중복 제거 후 정렬', () => {
  assert.equal(normalizeMsgrNotify(null), null); assert.equal(normalizeMsgrNotify(undefined), null); assert.equal(normalizeMsgrNotify('x'), null);
  assert.throws(() => normalizeMsgrNotify({ orgId: 'bad', channelId: CH }), /msgr_notify_bad_target/);
  assert.deepEqual(normalizeMsgrNotify({ orgId: ORG, channelId: CH, events: ['job', 'approval', 'job', 'nope'] }), { orgId: ORG, channelId: CH, events: ['approval', 'job'] });
  assert.deepEqual(normalizeMsgrNotify({ orgId: ORG, channelId: CH }).events, []);
  assert.ok(MSGR_NOTIFY_EVENTS.includes('approval') && MSGR_NOTIFY_EVENTS.includes('job'));
});

test('msgrNotifyWants — 켜진 종류만, 루틴은 자기 목적지가 없을 때만', () => {
  const n = { orgId: ORG, channelId: CH, events: ['job', 'routine'] };
  assert.equal(msgrNotifyWants(n, { type: 'job' }), true);
  assert.equal(msgrNotifyWants(n, { type: 'approval' }), false);
  assert.equal(msgrNotifyWants(n, { type: 'routine', routine: { id: 'r' } }), true);
  assert.equal(msgrNotifyWants(n, { type: 'routine', routine: { id: 'r', notifications: { channels: [] } } }), false, '루틴 자기 목적지(#513)가 우선');
  assert.equal(msgrNotifyWants(null, { type: 'job' }), false);
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

test('pushEvent — 원점 없는 이벤트만 회사 목적지로 간다(원점 있음·종류 미선택·미설정은 호출 0)', async () => {
  const { _pushEventForTest } = await import('../src/gateway.mjs');
  const { createCompany, loadCompany, updateCompany } = await import('../src/workspace.mjs');
  const ws = 'msgr-notify-room';
  await createCompany(ws, '알림 방 검수', 'beta');
  const calls = [];
  const notifyMsgr = async (event, target) => { calls.push({ type: event.type, ch: target.channelId }); return true; };
  const pushMsgr = async () => false;
  await _pushEventForTest({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { pushMsgr, notifyMsgr });
  assert.deepEqual(calls, [], '미설정이면 가지 않는다');
  const company = await loadCompany(ws);
  await updateCompany(ws, { msgr: { ...(company.msgr ?? {}), notify: { orgId: ORG, channelId: CH, events: ['job', 'crewmail'] } } });
  await _pushEventForTest({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r', msgr: { channelId: 'origin' } }, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ type: 'crewmail', wsId: ws, from: 'alpha', slug: 'beta', reply: '쪽지' }, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ type: 'crewmail', wsId: ws, from: 'alpha', slug: 'beta', reply: '쪽지', msgr: { channelId: 'origin' } }, { pushMsgr, notifyMsgr });
  await _pushEventForTest({ type: 'approval', wsId: ws, item: { id: 'a1', slug: 'beta', action: 'x' } }, { pushMsgr, notifyMsgr });
  assert.deepEqual(calls, [{ type: 'job', ch: CH }, { type: 'crewmail', ch: CH }], '원점 있는 job·crewmail과 미선택 approval은 제외');
  await updateCompany(ws, { msgr: { ...(await loadCompany(ws)).msgr, notify: { orgId: ORG, channelId: CH, events: ['job'] } } });
  const boom = async () => { throw new Error('room offline'); };
  await _pushEventForTest({ type: 'job', wsId: ws, slug: 'beta', title: 'T', ok: true, reply: 'r' }, { pushMsgr, notifyMsgr: boom });
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

test('msgrNotifyPush(배달층) — 정상 삽입 행 모양, 크루 부재 false, 브리지 꺼짐 false, 같은 본문 두 번은 같은 client_msg_id(중복은 false)', async () => {
  const { msgrNotifyPush } = await import('../src/gateway/msgr.mjs');
  const { createCompany, loadCompany, updateCompany } = await import('../src/workspace.mjs');
  const ws = 'msgr-notify-deliver';
  await createCompany(ws, '배달 검수', 'beta');
  const rows = []; const seen = new Set();
  const db = {
    crewBySlug: async (uid, w, slug, orgId) => (slug === 'beta' && orgId === ORG ? { id: 'crew-beta' } : null),
    insertMessage: async (row) => { rows.push(row); if (seen.has(row.client_msg_id)) return null; seen.add(row.client_msg_id); return { id: `m${rows.length}` }; },
  };
  const session = async () => ({ uid: 'owner-1', db });
  const target = { orgId: ORG, channelId: CH, events: ['job'] };
  const ev = { type: 'job', wsId: ws, slug: 'beta', title: '긴 작업', ok: true, reply: '끝' };
  const at = Date.parse('2026-09-14T14:00:00Z');
  assert.equal(await msgrNotifyPush(ev, target, { session, now: at }), false, '브리지 꺼짐(msgr.enabled 아님)이면 세션도 열지 않는다');
  await updateCompany(ws, { msgr: { ...((await loadCompany(ws)).msgr ?? {}), enabled: true } });
  assert.equal(await msgrNotifyPush(ev, target, { session, now: at }), true);
  assert.equal(rows.length, 1);
  assert.deepEqual({ channel_id: rows[0].channel_id, author_kind: rows[0].author_kind, crew_id: rows[0].crew_id, kind: rows[0].kind, mentions: rows[0].mentions, meta: rows[0].meta },
    { channel_id: CH, author_kind: 'crew', crew_id: 'crew-beta', kind: 'text', mentions: [], meta: { disposition: 'done', notification: 'job' } });
  assert.match(rows[0].body, /^\[장시간 작업 완료\] 긴 작업\n\n끝$/); assert.match(rows[0].client_msg_id, /^nt:crew-beta:[0-9a-f]{32}$/);
  assert.equal(await msgrNotifyPush(ev, target, { session, now: at + 5_000 }), false, '같은 이벤트 재배달(5초 뒤) = 같은 client_msg_id → 중복 삽입 없음');
  assert.equal(rows[1].client_msg_id, rows[0].client_msg_id);
  assert.equal(await msgrNotifyPush({ ...ev, reply: '끗' }, target, { session, now: at }), true, '같은 길이·다른 본문은 다른 알림(옛 길이 키의 유실 재발 방지)');
  assert.notEqual(rows[2].client_msg_id, rows[0].client_msg_id);
  assert.equal(await msgrNotifyPush(ev, target, { session, now: at + 3_600_000 }), true, '같은 문장이라도 다음 시간 버킷이면 새 알림(반복 루틴 영구 유실 방지)');
  assert.notEqual(rows[3].client_msg_id, rows[0].client_msg_id);
  assert.equal(await msgrNotifyPush({ ...ev, slug: 'nobody' }, target, { session, now: at }), false, '조직에 없는 크루 → false(다른 방·다른 이름으로 가지 않음)');
  assert.equal(rows.length, 4);
});
